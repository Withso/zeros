import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: runtime.invoke,
  useNativeRuntime: () => ({ ready: true }),
}));
vi.mock("../local-workspace-folders", () => ({
  registeredLocalWorkspaceFolders: () => [],
}));

import {
  LOCAL_DEV_SERVERS_HISTORY_LIMIT,
  LOCAL_DEV_SERVERS_MAX_EXCLUDES,
  LOCAL_DEV_SERVERS_SCOPE_LIMIT,
  LOCAL_DEV_SERVERS_STORAGE_KEY,
  LocalDevServerStore,
  buildLocalDevServerRows,
  clearOfflineHistory,
  isLocalWorkspaceFolder,
  isPathInsideFolder,
  localDevServersPollingEnabled,
  mergeHistory,
  nestedWorkspaceFolders,
  parseLocalDevServersResponse,
  readPersistedHistory,
  serializeHistory,
  type LocalDevServerHistoryEntry,
  type LocalDevServerScopeRequest,
} from "../local-dev-servers";

const CLOUD_SCOPE =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const APP = "/work/app";
const OTHER = "/work/other";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    values,
  };
}

const entry = (port: number, lastSeenAt: number, extra: Partial<LocalDevServerHistoryEntry> = {}) => ({
  port,
  url: `http://localhost:${port}`,
  lastSeenAt,
  ...extra,
});

const server = (port: number, extra: Record<string, string> = {}) => ({
  port,
  url: `http://localhost:${port}`,
  ...extra,
});

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("native response validation", () => {
  it("keeps only canonical localhost URLs matching their port", () => {
    expect(
      parseLocalDevServersResponse({
        root: "/w",
        servers: [
          { port: 5173, url: "http://localhost:5173", title: "App" },
          { port: 3000, url: "http://evil.test:3000" },
          { port: 3001, url: "http://localhost:3002" },
          { port: 5173, url: "http://localhost:5173" },
          { port: 4000, url: "http://localhost:4000", cwd: "/w" },
          "junk",
        ],
      }),
    ).toEqual({
      root: "/w",
      servers: [
        { port: 4000, url: "http://localhost:4000", cwd: "/w" },
        { port: 5173, url: "http://localhost:5173", title: "App" },
      ],
    });
    for (const raw of [null, { servers: [] }, { root: "relative", servers: [] }, { root: "/", servers: [] }])
      expect(() => parseLocalDevServersResponse(raw)).toThrow();
  });
});

describe("workspace folders", () => {
  it("accepts absolute workspace folders only", () => {
    expect(isLocalWorkspaceFolder(APP)).toBe(true);
    expect(isLocalWorkspaceFolder(`${APP}/`)).toBe(true);
    for (const scope of ["", "/", "//", "__ambient__", "relative/app", CLOUD_SCOPE, "/a\0b", `/${"a".repeat(5_000)}`])
      expect(isLocalWorkspaceFolder(scope)).toBe(false);
  });

  it("sends only the outermost registered folders strictly inside the workspace", () => {
    expect(
      nestedWorkspaceFolders(`${APP}/`, [
        APP,
        `${APP}/`,
        `${APP}/.claude/worktrees/b/`,
        `${APP}/.claude/worktrees/a`,
        `${APP}/.claude/worktrees/a/nested`,
        `${APP}-old/wt`,
        OTHER,
        CLOUD_SCOPE,
        "__ambient__",
      ]),
    ).toEqual([`${APP}/.claude/worktrees/a`, `${APP}/.claude/worktrees/b`]);
    expect(nestedWorkspaceFolders("/tmp/site", ["/private/tmp/site/wt"])).toEqual(["/tmp/site/wt"]);
    const many = Array.from({ length: LOCAL_DEV_SERVERS_MAX_EXCLUDES + 10 }, (_, i) => `${APP}/w${i}`);
    expect(nestedWorkspaceFolders(APP, many)).toHaveLength(LOCAL_DEV_SERVERS_MAX_EXCLUDES);
  });

  it("matches folders on path boundaries", () => {
    expect(isPathInsideFolder("/work/app/web", "/work/app")).toBe(true);
    expect(isPathInsideFolder("/work/app", "/work/app/")).toBe(true);
    expect(isPathInsideFolder("/work/application", "/work/app")).toBe(false);
    expect(isPathInsideFolder("/work/app", CLOUD_SCOPE)).toBe(false);
  });
});

describe("persisted history", () => {
  it("validates, dedupes, sorts and bounds each workspace's entries", () => {
    const entries = [
      entry(3000, 10),
      entry(3000, 20, { title: "newer" }),
      { port: 3001, url: "http://example.test:3001", lastSeenAt: 5 },
      { port: "x" },
      ...Array.from({ length: 40 }, (_, i) => entry(4000 + i, 100 + i)),
    ];
    const parsed = readPersistedHistory(
      JSON.stringify({ version: 2, scopes: { [APP]: entries, [OTHER]: [entry(5000, 1)] }, filter: "online" }),
    );
    expect(parsed.filter).toBe("online");
    expect(parsed.scopes.map(([scope]) => scope)).toEqual([APP, OTHER]);
    const app = parsed.scopes[0][1];
    expect(app).toHaveLength(LOCAL_DEV_SERVERS_HISTORY_LIMIT);
    expect(app[0]).toEqual(entry(4039, 139));
    expect(app.some((row) => row.url.includes("example.test"))).toBe(false);
  });

  it("drops scopes that are not workspace folders and bounds the scope count", () => {
    const scopes: Record<string, unknown> = {
      "/": [entry(1, 1)],
      relative: [entry(2, 1)],
      __ambient__: [entry(3, 1)],
      [CLOUD_SCOPE]: [entry(4, 1)],
      "/empty": [],
      "/junk": "x",
    };
    for (let i = 0; i < LOCAL_DEV_SERVERS_SCOPE_LIMIT + 5; i++) scopes[`/work/w${i}`] = [entry(3000, i)];
    const parsed = readPersistedHistory(JSON.stringify({ version: 2, scopes, filter: "all" }));
    expect(parsed.scopes).toHaveLength(LOCAL_DEV_SERVERS_SCOPE_LIMIT);
    expect(parsed.scopes[0][0]).toBe(`/work/w${LOCAL_DEV_SERVERS_SCOPE_LIMIT + 4}`);
    expect(parsed.scopes.every(([scope]) => scope.startsWith("/work/w"))).toBe(true);
  });

  it("returns empty history for malformed, foreign or machine-wide payloads", () => {
    for (const raw of [
      null,
      "",
      "{",
      "[]",
      JSON.stringify({ version: 1, entries: [entry(3000, 1)] }),
      JSON.stringify({ version: 2, scopes: [] }),
    ])
      expect(readPersistedHistory(raw)).toEqual({ scopes: [], filter: "all" });
  });

  it("round-trips through serialization", () => {
    const entries = [entry(5173, 50, { title: "Vite", cwd: "/work/app" })];
    expect(readPersistedHistory(serializeHistory([[APP, entries], [OTHER, []]], "all"))).toEqual({
      scopes: [[APP, entries]],
      filter: "all",
    });
  });
});

describe("history merge", () => {
  it("adds new servers and keeps the reference when nothing changed", () => {
    const first = mergeHistory([], [server(3000)], 1_000);
    expect(first).toEqual([entry(3000, 1_000)]);
    const again = mergeHistory(first, [server(3000)], 2_000);
    expect(again).toBe(first);
    const retitled = mergeHistory(first, [server(3000, { title: "T" })], 3_000);
    expect(retitled).toEqual([entry(3000, 3_000, { title: "T" })]);
    expect(mergeHistory(first, [], 9_000)).toBe(first);
  });

  it("evicts the oldest offline entries first at the cap", () => {
    const history = Array.from({ length: LOCAL_DEV_SERVERS_HISTORY_LIMIT }, (_, i) => entry(4000 + i, 100 + i));
    const next = mergeHistory(history, [server(9000)], 500);
    expect(next).toHaveLength(LOCAL_DEV_SERVERS_HISTORY_LIMIT);
    expect(next[0].port).toBe(9000);
    expect(next.some((row) => row.port === 4000)).toBe(false);
  });

  it("clears offline entries only", () => {
    const history = [entry(3000, 1), entry(4000, 2)];
    expect(clearOfflineHistory(history, [server(3000)])).toEqual([entry(3000, 1)]);
    expect(clearOfflineHistory(history, null)).toEqual([]);
    const kept = [entry(3000, 1)];
    expect(clearOfflineHistory(kept, [server(3000)])).toBe(kept);
  });
});

describe("rows", () => {
  it("sorts online by port, then offline by recency", () => {
    const rows = buildLocalDevServerRows({
      history: [entry(8000, 10), entry(8001, 30), entry(8002, 20, { cwd: "/work/app/web" })],
      probe: { root: APP, updatedAt: 99, servers: [server(6006, { cwd: APP }), server(5173)] },
      filter: "all",
    });
    expect(rows.map((row) => [row.port, row.status])).toEqual([
      [5173, "online"],
      [6006, "online"],
      [8001, "offline"],
      [8002, "offline"],
      [8000, "offline"],
    ]);
  });

  it("marks history unknown before the first probe and filters to online", () => {
    const history = [entry(8000, 10)];
    expect(buildLocalDevServerRows({ history, probe: null, filter: "all" })[0].status).toBe("unknown");
    expect(
      buildLocalDevServerRows({ history, probe: { root: APP, servers: [], updatedAt: 1 }, filter: "online" }),
    ).toEqual([]);
  });
});

describe("store", () => {
  it("probes the workspace with its nested registered workspaces excluded", async () => {
    const invoke = vi.fn(async (_request: LocalDevServerScopeRequest) => ({ root: APP, servers: [] }));
    const store = new LocalDevServerStore({
      invoke,
      workspaceFolders: () => [APP, `${APP}/.claude/worktrees/x`, `${APP}/.claude/worktrees/x/deep`, OTHER, CLOUD_SCOPE],
      storage: () => memoryStorage(),
    });
    await store.refresh(`${APP}/`);
    expect(invoke).toHaveBeenCalledWith({ root: APP, exclude: [`${APP}/.claude/worktrees/x`] });
  });

  it("shares one in-flight probe per workspace, persists history and keeps the last snapshot on failure", async () => {
    let now = 10_000;
    const pending = deferred();
    const invoke = vi.fn((_request: LocalDevServerScopeRequest) => pending.promise);
    const storage = memoryStorage();
    const store = new LocalDevServerStore({ invoke, storage: () => storage, now: () => now });
    const first = store.refresh(APP);
    expect(store.refresh(APP)).toBe(first);
    pending.resolve({ root: APP, servers: [server(3000, { title: "Web", cwd: APP })] });
    await first;
    expect(invoke).toHaveBeenCalledTimes(1);
    const confirmed = store.getState(APP);
    expect(confirmed.probe?.servers).toHaveLength(1);
    expect(readPersistedHistory(storage.values.get(LOCAL_DEV_SERVERS_STORAGE_KEY) ?? null).scopes).toEqual([
      [APP, [entry(3000, 10_000, { title: "Web", cwd: APP })]],
    ]);

    await store.refresh(APP);
    expect(invoke).toHaveBeenCalledTimes(1);

    // An unchanged probe keeps every reference and notifies nobody.
    const listener = vi.fn();
    store.subscribe(listener);
    now += 5_000;
    invoke.mockImplementationOnce(async () => ({ root: APP, servers: [server(3000, { title: "Web", cwd: APP })] }));
    await store.refresh(APP);
    expect(store.getState(APP)).toBe(confirmed);
    expect(listener).not.toHaveBeenCalled();

    now += 5_000;
    invoke.mockImplementation(() => Promise.reject(new Error("offline")));
    await store.refresh(APP);
    const failed = store.getState(APP);
    expect(failed.probe).toBe(confirmed.probe);
    expect(failed.error?.message).toBe("offline");
    now += 5_000;
    await store.refresh(APP);
    expect(store.getState(APP)).toBe(failed);
  });

  it("keys snapshots by workspace so a late response never paints or clears another", async () => {
    const slow = deferred();
    const invoke = vi.fn((request: LocalDevServerScopeRequest) =>
      request.root === APP ? slow.promise : Promise.resolve({ root: OTHER, servers: [server(4000, { cwd: OTHER })] }),
    );
    const store = new LocalDevServerStore({ invoke, storage: () => memoryStorage() });
    const app = store.refresh(APP);
    await store.refresh(OTHER);
    const other = store.getState(OTHER);
    expect(other.probe?.servers.map((row) => row.port)).toEqual([4000]);
    expect(store.getState(APP).probe).toBeNull();
    slow.resolve({ root: APP, servers: [server(3000, { cwd: APP })] });
    await app;
    expect(store.getState(APP).probe?.servers.map((row) => row.port)).toEqual([3000]);
    expect(store.getState(OTHER)).toBe(other);
    expect(store.getState(`${APP}/`)).toBe(store.getState(APP));
  });

  it("never probes cloud, folderless or root scopes", async () => {
    const invoke = vi.fn(async () => ({ root: APP, servers: [] }));
    const store = new LocalDevServerStore({ invoke, storage: () => memoryStorage() });
    for (const scope of [CLOUD_SCOPE, "__ambient__", "", "/"]) {
      await store.refresh(scope, { force: true });
      expect(store.getState(scope).probe).toBeNull();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("restores persisted history per workspace and clears offline entries for that workspace only", async () => {
    const storage = memoryStorage({
      [LOCAL_DEV_SERVERS_STORAGE_KEY]: serializeHistory(
        [
          [APP, [entry(3000, 1), entry(4000, 2)]],
          [OTHER, [entry(5000, 3)]],
        ],
        "online",
      ),
    });
    const store = new LocalDevServerStore({
      invoke: async () => ({ root: APP, servers: [server(3000)] }),
      storage: () => storage,
      now: () => 100_000,
    });
    expect(store.getState(APP).history).toHaveLength(2);
    expect(store.getState(OTHER).history).toHaveLength(1);
    expect(store.getFilter()).toBe("online");
    await store.refresh(APP);
    store.clearHistory(APP);
    expect(store.getState(APP).history.map((row) => row.port)).toEqual([3000]);
    expect(store.getState(OTHER).history.map((row) => row.port)).toEqual([5000]);
    store.setFilter("all");
    const persisted = readPersistedHistory(storage.values.get(LOCAL_DEV_SERVERS_STORAGE_KEY) ?? null);
    expect(persisted.filter).toBe("all");
    expect(Object.fromEntries(persisted.scopes.map(([scope, rows]) => [scope, rows.map((row) => row.port)]))).toEqual({
      [APP]: [3000],
      [OTHER]: [5000],
    });
  });

  it("forgets the least recently probed workspace beyond the cap", async () => {
    const storage = memoryStorage();
    const store = new LocalDevServerStore({
      invoke: async (request) => ({ root: request.root, servers: [server(3000)] }),
      storage: () => storage,
    });
    for (let i = 0; i <= LOCAL_DEV_SERVERS_SCOPE_LIMIT; i++) await store.refresh(`/work/w${i}`);
    expect(store.getState("/work/w0").history).toEqual([]);
    expect(store.getState(`/work/w${LOCAL_DEV_SERVERS_SCOPE_LIMIT}`).history).toHaveLength(1);
    const persisted = readPersistedHistory(storage.values.get(LOCAL_DEV_SERVERS_STORAGE_KEY) ?? null);
    expect(persisted.scopes).toHaveLength(LOCAL_DEV_SERVERS_SCOPE_LIMIT);
    expect(persisted.scopes.some(([scope]) => scope === "/work/w0")).toBe(false);
  });

  it("survives unavailable storage and a failing workspace registry", async () => {
    const invoke = vi.fn(async () => ({ root: APP, servers: [] }));
    const store = new LocalDevServerStore({
      invoke,
      workspaceFolders: () => {
        throw new Error("registry");
      },
      storage: () => {
        throw new Error("denied");
      },
    });
    expect(store.getState(APP).history).toEqual([]);
    await store.refresh(APP);
    expect(invoke).toHaveBeenCalledWith({ root: APP, exclude: [] });
    expect(store.getState(APP).probe?.servers).toEqual([]);
  });
});

describe("polling gate", () => {
  it("polls only for an active, visible Local workspace folder", () => {
    const base = { scope: APP, active: true, nativeReady: true, documentVisible: true };
    expect(localDevServersPollingEnabled(base)).toBe(true);
    expect(localDevServersPollingEnabled({ ...base, active: false })).toBe(false);
    expect(localDevServersPollingEnabled({ ...base, documentVisible: false })).toBe(false);
    expect(localDevServersPollingEnabled({ ...base, nativeReady: false })).toBe(false);
    for (const scope of [CLOUD_SCOPE, "", "__ambient__", "/"])
      expect(localDevServersPollingEnabled({ ...base, scope })).toBe(false);
  });
});
