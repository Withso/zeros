import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_STORAGE_CATEGORY_IDS,
  type LocalStorageCategoryId,
  type LocalStorageReport,
} from "../../shared/local-storage";
import { appIdentity, zerosChannelDataDir, zerosDataDir, zerosLocalLogDir, zerosLocalSessionDataDir } from "../../src/engine/db/paths";
import type { DuOptions, DuResult } from "../local-storage/du";
import { resolveLocalStorageLocations, updaterLocations, type LocalStorageLocations } from "../local-storage/locations";
import { planLocalStorage, revealTarget, type LocalStoragePlan } from "../local-storage/plan";
import { createLocalStorageService, type Measurer } from "../local-storage/service";

// Inject errno failures for chosen paths; every other call is the real fs.
const faults = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const fault = (call: string, target: unknown) => {
    const code = faults.get(`${call}:${String(target)}`);
    if (code) throw Object.assign(new Error(`${code}: ${call} ${String(target)}`), { code });
  };
  const wrapped = {
    ...actual,
    realpath: (async (target: string, ...rest: unknown[]) => {
      fault("realpath", target);
      return (actual.realpath as (...a: unknown[]) => Promise<string>)(target, ...rest);
    }) as typeof actual.realpath,
    readdir: (async (target: string, ...rest: unknown[]) => {
      fault("readdir", target);
      return (actual.readdir as (...a: unknown[]) => Promise<string[]>)(target, ...rest);
    }) as typeof actual.readdir,
    lstat: (async (target: string, ...rest: unknown[]) => {
      fault("lstat", target);
      return (actual.lstat as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof actual.lstat,
  };
  return { ...wrapped, default: wrapped };
});

const ENV = ["HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ZEROS_DATA_DIR", "ZEROS_WORKSPACES_DIR", "ZEROS_DESIGN_WORKSPACES_DIR",
  "ZEROS_DEV", "ZEROS_RUNTIME_MODE", "ZEROS_CHANNEL", "ZEROS_INSTANCE", "ZEROS_LOCAL_DEVELOPMENT", "ZEROS_LOCAL_LAYOUT"] as const;
const saved: Record<string, string | undefined> = {};
const realPlatform = process.platform;
let home: string;

beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-storage-home-")));
  process.env.HOME = home;
  Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(() => {
  faults.clear();
  Object.defineProperty(process, "platform", { value: realPlatform });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

const AS = () => path.join(home, "Library", "Application Support");
const CACHES = () => path.join(home, "Library", "Caches");
const INSTANCE = "a123456789abcdef";

type Identity = "stable" | "alpha" | "hosted-dev" | "local-v2" | "local-legacy";

/** What main.ts hands the page for each kind of identity: Electron's own
 * userData/sessionData and the log folder main opened, never a derivation. */
function runtimeFor(identity: Identity) {
  if (identity === "alpha") process.env.ZEROS_CHANNEL = "alpha";
  if (identity === "hosted-dev") Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev" });
  if (identity === "local-v2" || identity === "local-legacy")
    Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: INSTANCE });
  if (identity === "local-legacy") process.env.ZEROS_LOCAL_LAYOUT = "legacy";
  const dev = identity !== "stable" && identity !== "alpha";
  const packaged = !dev;
  return {
    userData: zerosDataDir(),
    sessionData: zerosLocalSessionDataDir() ?? path.join(CACHES(), appIdentity()),
    logDir: zerosLocalLogDir() ?? path.join(home, "Library", "Logs", appIdentity()),
    secretsDir: dev ? zerosChannelDataDir() : zerosDataDir(),
    updates: updaterLocations({ packaged, platform: "darwin", cacheRoot: CACHES(), updaterCacheDirName: "zeros-updater", bundleId: appIdentity() }),
  };
}

function file(target: string, bytes = 16): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes));
}

/** A realistic profile for the identity, every location populated. */
function populate(locations: LocalStorageLocations): void {
  const data = locations.dataDir;
  for (const name of ["zeros.db", "zeros.db-wal", "zeros.db-shm", "zeros.db.pre-migration-v41-20261101T000000Z.bak"])
    file(path.join(data, name));
  file(path.join(data, "secrets.json"));
  file(path.join(data, "app-settings.json"));
  file(path.join(data, "design-storage", "chunk"));
  file(path.join(data, "engines", "repo-abc", "engine.json"));
  file(path.join(locations.providerAccounts, "claude", "uuid", "settings.json"));
  for (const name of ["Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "GrShaderCache", "Shared Dictionary", "blob_storage"])
    file(path.join(locations.sessionData, name, "data"));
  for (const name of ["Local Storage", "IndexedDB", "Session Storage", "Partitions", "A Future Chromium Folder"])
    file(path.join(locations.sessionData, name, "data"));
  file(path.join(locations.sessionData, "Preferences"));
  file(path.join(locations.stateRoot, "settings.toml"));
  file(path.join(locations.stateRoot, "worktrees", "legacy-ws", "README.md"));
  file(path.join(locations.logDir!, "main.log"));
  file(path.join(locations.workspaces, "ws-1", "src", "index.ts"));
  file(path.join(locations.designWorkspaces, "board", "page.html"));
  file(path.join(locations.cloudSync, "repo", "1", "file.txt"));
  for (const root of locations.updates) file(path.join(root, "pending", "update.zip"));
}

const rel = (plan: LocalStoragePlan, id: LocalStorageCategoryId) =>
  plan[id].paths.map((p) => path.relative(home, p)).sort();

function expectDisjoint(plan: LocalStoragePlan): void {
  const all = LOCAL_STORAGE_CATEGORY_IDS.flatMap((id) => plan[id].paths);
  expect(new Set(all).size).toBe(all.length);
  for (const a of all) for (const b of all) if (a !== b) expect(b.startsWith(`${a}${path.sep}`)).toBe(false);
}

describe("planLocalStorage per identity", () => {
  it.each<Identity>(["stable", "alpha", "hosted-dev", "local-v2", "local-legacy"])(
    "%s: every location lands in exactly one row",
    async (identity) => {
      const locations = resolveLocalStorageLocations(runtimeFor(identity));
      populate(locations);
      const plan = await planLocalStorage(locations);
      expectDisjoint(plan);

      const inData = (name: string) => path.relative(home, path.join(locations.dataDir, name));
      const inSession = (name: string) => path.relative(home, path.join(locations.sessionData, name));
      expect(rel(plan, "chats")).toEqual(
        ["zeros.db", "zeros.db-shm", "zeros.db-wal", "zeros.db.pre-migration-v41-20261101T000000Z.bak"].map(inData).sort(),
      );
      expect(rel(plan, "provider-accounts")).toEqual([path.relative(home, locations.providerAccounts)]);
      expect(rel(plan, "cache")).toEqual(
        ["Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "GrShaderCache", "Shared Dictionary", "blob_storage"].map(inSession).sort(),
      );
      expect(rel(plan, "window-state")).toEqual(
        ["Local Storage", "IndexedDB", "Session Storage", "Partitions", "A Future Chromium Folder", "Preferences"].map(inSession).sort(),
      );
      const other = rel(plan, "other-app-data");
      for (const name of ["secrets.json", "app-settings.json", "design-storage", "engines"]) expect(other).toContain(inData(name));
      expect(other).toContain(path.relative(home, path.join(locations.stateRoot, "settings.toml")));
      for (const leaked of ["zeros.db", "provider-accounts", "electron", "logs"]) expect(other).not.toContain(inData(leaked));
      expect(rel(plan, "logs")).toEqual([path.relative(home, locations.logDir!)]);
      expect(rel(plan, "workspaces")).toEqual(
        [
          path.join(locations.workspaces, "ws-1"),
          path.join(locations.designWorkspaces, "board"),
          path.join(locations.stateRoot, "worktrees"),
        ].map((p) => path.relative(home, p)).sort(),
      );
      expect(rel(plan, "cloud-sync")).toEqual([path.relative(home, path.join(locations.cloudSync, "repo"))]);
      expect(plan.updates.paths.length).toBe(identity === "stable" || identity === "alpha" ? 2 : 0);
      expect(plan.workspaces.location).toBe(`~${locations.workspaces.slice(home.length)}`);
      expect(plan["cloud-sync"].location).toBe(`~${locations.cloudSync.slice(home.length)}`);
      expect(plan.chats.location).toBeNull();
    },
  );

  it("resolves each identity's own roots", () => {
    expect(resolveLocalStorageLocations(runtimeFor("stable"))).toMatchObject({
      dataDir: path.join(AS(), "com.zeros"),
      sessionData: path.join(CACHES(), "com.zeros"),
      updates: [path.join(CACHES(), "zeros-updater"), path.join(CACHES(), "com.zeros.ShipIt")],
      workspaces: path.join(home, "zeros", "workspaces"),
      cloudSync: path.join(home, "zeros", "cloud-sync"),
    });
    for (const key of ENV) if (key !== "HOME") delete process.env[key];
    expect(resolveLocalStorageLocations(runtimeFor("alpha"))).toMatchObject({
      dataDir: path.join(AS(), "com.zeros.alpha"),
      // Stable and Alpha share electron-updater's download folder.
      updates: [path.join(CACHES(), "zeros-updater"), path.join(CACHES(), "com.zeros.alpha.ShipIt")],
    });
  });

  it("Local v2: the profile inside the data folder is counted once, as the profile", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("local-v2"));
    expect(locations.sessionData).toBe(path.join(locations.dataDir, "electron"));
    populate(locations);
    const plan = await planLocalStorage(locations);
    expectDisjoint(plan);
    expect(plan["other-app-data"].paths).not.toContain(locations.sessionData);
    expect(plan.cache.paths).toContain(path.join(locations.sessionData, "Cache"));
  });

  it("legacy Local: the profile stays outside the data folder", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("local-legacy"));
    expect(locations.sessionData).toBe(path.join(CACHES(), `com.zeros.local.${INSTANCE}`));
    expect(locations.dataDir).toBe(path.join(AS(), `com.zeros.local.${INSTANCE}`));
  });

  it("follows a moved profile: a session inside the data folder is stepped around wherever it nests", async () => {
    const locations = resolveLocalStorageLocations({
      ...runtimeFor("stable"),
      sessionData: path.join(AS(), "com.zeros", "profiles", "default", "chromium"),
    });
    populate(locations);
    file(path.join(locations.dataDir, "profiles", "default", "other.json"));
    const plan = await planLocalStorage(locations);
    expectDisjoint(plan);
    expect(plan["other-app-data"].paths).toContain(path.join(locations.dataDir, "profiles", "default", "other.json"));
    expect(plan["other-app-data"].paths).not.toContain(path.join(locations.dataDir, "profiles"));
    expect(plan.cache.paths).toContain(path.join(locations.sessionData, "GPUCache"));
  });

  it("puts Linux-style logs inside the data folder under Logs only", async () => {
    const runtime = runtimeFor("stable");
    const locations = resolveLocalStorageLocations({ ...runtime, logDir: path.join(runtime.userData, "logs") });
    populate(locations);
    const plan = await planLocalStorage(locations);
    expectDisjoint(plan);
    expect(plan.logs.paths).toEqual([path.join(locations.dataDir, "logs")]);
  });

  it("treats missing folders as nothing to measure, not an error", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    const plan = await planLocalStorage(locations);
    for (const id of LOCAL_STORAGE_CATEGORY_IDS) {
      expect(plan[id].paths).toEqual([]);
      expect(plan[id].reveal).toBeNull();
    }
  });

  it("an unresolvable root is unknown, not missing: its rows are not measured as zero", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    faults.set(`realpath:${locations.workspaces}`, "EACCES");
    faults.set(`realpath:${locations.sessionData}`, "EIO");
    const plan = await planLocalStorage(locations);
    expect(plan.workspaces.unresolved).toBe(true);
    // Every row the profile's entries could land in is unknown.
    expect(plan.cache.unresolved).toBe(true);
    expect(plan["window-state"].unresolved).toBe(true);
    expect(plan.cache.paths).toEqual([]);
    for (const id of ["chats", "provider-accounts", "other-app-data", "logs", "cloud-sync"] as const)
      expect(plan[id].unresolved, id).toBe(false);
  });

  it("an unlistable root leaves every row it feeds unknown", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    faults.set(`readdir:${locations.dataDir}`, "EACCES");
    const plan = await planLocalStorage(locations);
    for (const id of ["chats", "provider-accounts", "other-app-data"] as const) expect(plan[id].unresolved, id).toBe(true);
    expect(plan.cache.unresolved).toBe(false);
  });

  it.each(["ENOENT", "ENOTDIR"])("%s from a root still means absent, measured as nothing", async (code) => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    faults.set(`realpath:${locations.cloudSync}`, code);
    const plan = await planLocalStorage(locations);
    expect(plan["cloud-sync"]).toMatchObject({ paths: [], unresolved: false });
  });

  it("Reveal treats only ENOENT/ENOTDIR as absent", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    faults.set(`lstat:${locations.logDir}`, "EACCES");
    expect(await revealTarget(locations, "logs")).toBe(locations.logDir);
    faults.set(`lstat:${locations.logDir}`, "ENOENT");
    expect(await revealTarget(locations, "logs")).toBeNull();
  });

  it("does not count a symlinked alias twice", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    fs.symlinkSync(locations.dataDir, path.join(locations.workspaces, "alias-to-data"));
    const plan = await planLocalStorage(locations);
    expectDisjoint(plan);
    expect(plan.workspaces.paths).toContain(path.join(locations.workspaces, "alias-to-data"));
  });

  it("reveals only an existing location of a revealable row", async () => {
    const locations = resolveLocalStorageLocations(runtimeFor("stable"));
    populate(locations);
    expect(await revealTarget(locations, "chats")).toBe(path.join(locations.dataDir, "zeros.db"));
    expect(await revealTarget(locations, "workspaces")).toBe(locations.workspaces);
    expect(await revealTarget(locations, "cache")).toBeNull();
    expect(await revealTarget(locations, "updates")).toBeNull();
    fs.rmSync(locations.logDir!, { recursive: true });
    expect(await revealTarget(locations, "logs")).toBeNull();
  });
});

// ── Run coordination with an injected measurer ──────────────────────────────

const PLAN = Object.fromEntries(
  LOCAL_STORAGE_CATEGORY_IDS.map((id) => [id, { paths: [`/fixture/${id}`], location: null, reveal: null, unresolved: false }]),
) as LocalStoragePlan;

interface Call {
  id: LocalStorageCategoryId;
  options: DuOptions;
  resolve: (result: DuResult) => void;
}

function harness(overrides: { plan?: () => Promise<LocalStoragePlan>; concurrency?: number } = {}) {
  const calls: Call[] = [];
  const reports: LocalStorageReport[] = [];
  let active = 0;
  let peak = 0;
  const measure: Measurer = (paths, options) =>
    new Promise<DuResult>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      const id = (paths[0]?.slice("/fixture/".length) ?? "(no paths)") as LocalStorageCategoryId;
      const call: Call = {
        id,
        options,
        resolve: (result) => {
          active -= 1;
          resolve(result);
        },
      };
      options.signal?.addEventListener("abort", () => {
        Object.assign(call, { done: true });
        call.resolve({ status: "unmeasured", bytes: null, reason: "cancelled" });
      }, { once: true });
      calls.push(call);
    });
  const planner = vi.fn(overrides.plan ?? (async () => PLAN));
  const service = createLocalStorageService({
    locations: () => ({}) as LocalStorageLocations,
    plan: planner,
    revealTarget: async () => null,
    measure,
    emit: (report) => reports.push(report),
    concurrency: overrides.concurrency ?? 2,
    progressIntervalMs: 0,
  });
  const settleNext = async (bytes: number | ((id: LocalStorageCategoryId) => DuResult)) => {
    await vi.waitFor(() => expect(calls.some((call) => !("done" in call))).toBe(true));
    const call = calls.find((c) => !("done" in c))!;
    Object.assign(call, { done: true });
    call.resolve(typeof bytes === "number" ? { status: "measured", bytes } : bytes(call.id));
    return call.id;
  };
  const settleAll = async (bytes: (id: LocalStorageCategoryId) => DuResult, count: number = LOCAL_STORAGE_CATEGORY_IDS.length) => {
    for (let i = 0; i < count; i++) await settleNext(bytes);
  };
  return { service, calls, reports, planner, peak: () => peak, settleNext, settleAll };
}

const byId = (report: LocalStorageReport, id: LocalStorageCategoryId) => report.categories.find((c) => c.id === id)!;

describe("createLocalStorageService", () => {
  it("does nothing until asked", () => {
    const h = harness();
    expect(h.calls).toEqual([]);
    expect(h.planner).not.toHaveBeenCalled();
    expect(h.reports).toEqual([]);
    expect(h.service.report().measuring).toBe(false);
    expect(h.service.report().categories.every((c) => c.status === "unmeasured" && c.bytes === null)).toBe(true);
  });

  it("shares one run between requests and bounds concurrency", async () => {
    const h = harness();
    const first = h.service.measure();
    const second = h.service.measure();
    expect(second).toBe(first);
    await h.settleAll(() => ({ status: "measured", bytes: 1024 }));
    const report = await first;
    expect(h.planner).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.id).sort()).toEqual([...LOCAL_STORAGE_CATEGORY_IDS].sort());
    expect(h.peak()).toBe(2);
    expect(report.measuring).toBe(false);
    expect(report.measuredAt).not.toBeNull();
    expect(report.categories.every((c) => c.status === "measured" && c.bytes === 1024)).toBe(true);
  });

  it("streams each category as it completes, smallest folders first", async () => {
    const h = harness({ concurrency: 1 });
    const run = h.service.measure();
    const first = await h.settleNext(10);
    expect(first).toBe("chats");
    await vi.waitFor(() => expect(byId(h.reports.at(-1)!, "chats")).toMatchObject({ status: "measured", bytes: 10, measuring: false }));
    expect(h.reports.at(-1)!.measuring).toBe(true);
    expect(byId(h.reports.at(-1)!, "workspaces").measuring).toBe(true);
    await h.settleAll(() => ({ status: "measured", bytes: 1 }), LOCAL_STORAGE_CATEGORY_IDS.length - 1);
    await run;
    expect(h.calls.at(-1)!.id).toBe("workspaces");
  });

  it("reports progress as a lower bound while a category is walked", async () => {
    const h = harness({ concurrency: 1 });
    void h.service.measure();
    await vi.waitFor(() => expect(h.calls.length).toBe(1));
    h.calls[0]!.options.onProgress!(4096);
    await vi.waitFor(() => expect(byId(h.reports.at(-1)!, "chats").progressBytes).toBe(4096));
    expect(byId(h.reports.at(-1)!, "chats").bytes).toBeNull();
  });

  it("keeps the last confirmed values on screen while measuring again", async () => {
    const h = harness();
    const first = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 500 }));
    await first;
    void h.service.measure();
    const during = h.reports.at(-1)!;
    expect(during.measuring).toBe(true);
    expect(during.categories.every((c) => c.measuring && c.bytes === 500 && c.status === "measured")).toBe(true);
  });

  it("shows a timeout or failure as not measured, and a partial walk as a lower bound", async () => {
    const h = harness();
    const run = h.service.measure();
    await h.settleAll((id) =>
      id === "workspaces"
        ? { status: "unmeasured", bytes: null, reason: "timeout" }
        : id === "cloud-sync"
          ? { status: "partial", bytes: 2048, reason: "errors" }
          : { status: "measured", bytes: 1 },
    );
    const report = await run;
    expect(byId(report, "workspaces")).toMatchObject({ status: "unmeasured", bytes: null });
    expect(byId(report, "cloud-sync")).toMatchObject({ status: "partial", bytes: 2048 });
  });

  it("drops a previous number when a later measurement fails rather than keep a stale exact value", async () => {
    const h = harness();
    const first = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 9 }));
    await first;
    const second = h.service.measure();
    await h.settleAll((id) => (id === "logs" ? { status: "unmeasured", bytes: null, reason: "failed" } : { status: "measured", bytes: 9 }));
    expect(byId(await second, "logs")).toMatchObject({ status: "unmeasured", bytes: null });
  });

  it("treats a measurer exception as not measured", async () => {
    const h = harness();
    const service = createLocalStorageService({
      locations: () => ({}) as LocalStorageLocations,
      plan: async () => PLAN,
      revealTarget: async () => null,
      measure: async () => {
        throw new Error("spawn EACCES");
      },
      emit: () => {},
    });
    const report = await service.measure();
    expect(report.categories.every((c) => c.status === "unmeasured" && c.bytes === null)).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it("marks every category not measured when the locations cannot be planned", async () => {
    const h = harness({ plan: async () => Promise.reject(new Error("EACCES")) });
    const report = await h.service.measure();
    expect(report.measuring).toBe(false);
    expect(report.categories.every((c) => c.status === "unmeasured" && !c.measuring)).toBe(true);
  });

  it("shows a row whose location could not be resolved as not measured, without running du for it", async () => {
    const plan = { ...PLAN, workspaces: { ...PLAN.workspaces, paths: [], unresolved: true } };
    const h = harness({ plan: async () => plan });
    const first = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 5 }), LOCAL_STORAGE_CATEGORY_IDS.length - 1);
    const report = await first;
    expect(h.calls.map((c) => c.id)).not.toContain("workspaces");
    expect(byId(report, "workspaces")).toMatchObject({ status: "unmeasured", bytes: null, measuring: false });
  });

  it("a planner failure after cancel keeps the last confirmed values", async () => {
    let fail: (error: Error) => void = () => {};
    let planning = 0;
    const h = harness({
      plan: () => (planning++ === 0 ? Promise.resolve(PLAN) : new Promise<LocalStoragePlan>((_, reject) => (fail = reject))),
    });
    const first = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 77 }));
    await first;
    const second = h.service.measure();
    await vi.waitFor(() => expect(planning).toBe(2));
    h.service.cancel();
    fail(new Error("EIO"));
    const report = await second;
    expect(report.measuring).toBe(false);
    expect(report.categories.every((c) => c.status === "measured" && c.bytes === 77 && !c.measuring)).toBe(true);
  });

  it("cancels the children and keeps the last confirmed values", async () => {
    const h = harness();
    const first = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 77 }));
    await first;
    const second = h.service.measure();
    await vi.waitFor(() => expect(h.calls.length).toBe(LOCAL_STORAGE_CATEGORY_IDS.length + 2));
    const inFlight = h.calls.slice(-2);
    h.service.cancel();
    const report = await second;
    for (const call of inFlight) expect(call.options.signal?.aborted).toBe(true);
    expect(h.calls.length).toBe(LOCAL_STORAGE_CATEGORY_IDS.length + 2);
    expect(report.measuring).toBe(false);
    expect(report.measuredAt).toBe((await first).measuredAt);
    expect(report.categories.every((c) => c.bytes === 77 && !c.measuring)).toBe(true);
    // A new request after cancellation starts a fresh run.
    expect(h.service.measure()).not.toBe(second);
  });

  it("revisions only increase", async () => {
    const h = harness();
    const run = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 1 }));
    await run;
    const revisions = h.reports.map((r) => r.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });
});

describe("clearCache", () => {
  it("measures the cache before and after and reports the difference as freed", async () => {
    const h = harness();
    const clear = vi.fn(async () => {});
    const pending = h.service.clearCache(clear);
    expect(await h.settleNext(61_000_000)).toBe("cache");
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(await h.settleNext(19_000_000)).toBe("cache");
    const result = await pending;
    expect(result.freedBytes).toBe(42_000_000);
    expect(byId(result.report, "cache")).toMatchObject({ status: "measured", bytes: 19_000_000, measuring: false });
  });

  it("reports freed as unknown when either side was not measured", async () => {
    const h = harness();
    const pending = h.service.clearCache(async () => {});
    await h.settleNext(() => ({ status: "unmeasured", bytes: null, reason: "timeout" }));
    await h.settleNext(5);
    expect((await pending).freedBytes).toBeNull();
  });

  it("supersedes a measurement in flight, then resumes what it had left", async () => {
    const h = harness({ concurrency: 1 });
    const run = h.service.measure();
    expect(await h.settleNext(1)).toBe("chats");
    await vi.waitFor(() => expect(h.calls.length).toBe(2));
    const clear = vi.fn(async () => {});
    const clearing = h.service.clearCache(clear);
    expect((await run).measuring).toBe(true);
    expect(await h.settleNext(10)).toBe("cache");
    expect(await h.settleNext(4)).toBe("cache");
    expect((await clearing).freedBytes).toBe(6);
    await vi.waitFor(() => expect(h.service.report().measuring).toBe(true));
    const resumed: LocalStorageCategoryId[] = [];
    for (let i = 0; i < LOCAL_STORAGE_CATEGORY_IDS.length - 2; i++) resumed.push(await h.settleNext(1));
    expect(resumed.sort()).toEqual(LOCAL_STORAGE_CATEGORY_IDS.filter((id) => id !== "chats" && id !== "cache").sort());
    await vi.waitFor(() => expect(h.service.report().measuring).toBe(false));
  });

  it("cancel stops the cache samples, still clears, and reports freed as unknown", async () => {
    const h = harness();
    const clear = vi.fn(async () => {});
    const pending = h.service.clearCache(clear);
    await vi.waitFor(() => expect(h.calls.length).toBe(1));
    h.service.cancel();
    const result = await pending;
    expect(h.calls[0]!.options.signal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(result.freedBytes).toBeNull();
    expect(result.report.measuring).toBe(false);
  });

  it("cancel drops a measurement queued behind clearing, and the resume clearing would start", async () => {
    const h = harness({ concurrency: 1 });
    const run = h.service.measure();
    expect(await h.settleNext(1)).toBe("chats");
    await vi.waitFor(() => expect(h.calls.length).toBe(2));
    const clearing = h.service.clearCache(async () => {});
    await run;
    const queued = h.service.measure();
    h.service.cancel();
    await clearing;
    const report = await queued;
    expect(report.measuring).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Only the interrupted walk and clearing's own samples ever ran du.
    expect(h.calls.filter((c) => !("done" in c))).toEqual([]);
    expect(h.calls.map((c) => c.id)).toEqual(["chats", "provider-accounts", "cache", "cache"].slice(0, h.calls.length));
    expect(h.service.report().measuring).toBe(false);
  });

  it("a later measure after a cancelled clear starts normally", async () => {
    const h = harness();
    const clearing = h.service.clearCache(async () => {});
    h.service.cancel();
    await clearing;
    const next = h.service.measure();
    await h.settleAll(() => ({ status: "measured", bytes: 2 }));
    expect((await next).categories.every((c) => c.bytes === 2)).toBe(true);
  });

  it("shares a second click and makes a measure request wait for it", async () => {
    const h = harness();
    const clear = vi.fn(async () => {});
    const a = h.service.clearCache(clear);
    expect(h.service.clearCache(clear)).toBe(a);
    const measuring = h.service.measure();
    await h.settleNext(3);
    await h.settleNext(1);
    await a;
    expect(clear).toHaveBeenCalledTimes(1);
    await h.settleAll(() => ({ status: "measured", bytes: 1 }));
    expect((await measuring).measuring).toBe(false);
  });
});
