import { describe, expect, it, vi } from "vitest";
import type { SyncEngine } from "../workspace-sync/engine";
import { SyncManager, type SyncManagerDeps } from "../workspace-sync/manager";
import { SyncConnectError } from "../workspace-sync/connection";
import type { WorkspaceSyncStatus } from "../../shared/workspace-sync";

const WS = "11111111-1111-4111-8111-111111111111";
function fixture(options: { connect?: SyncManagerDeps["connect"]; pull?: () => Promise<{ state: "in_sync" | "retry" | "stopped"; problems: []; skipped: []; stopped?: "too_many_files" }> } = {}) {
  const settings = new Map<string, string>(), flags: Array<[string, boolean]> = [], published: WorkspaceSyncStatus[][] = [];
  let account: { accountId: string; deviceId: string } | null = { accountId: "acct-a", deviceId: "22222222-2222-4222-8222-222222222222" };
  const pull = vi.fn(options.pull ?? (async () => ({ state: "in_sync" as const, problems: [] as [], skipped: [] as [] })));
  const closed = vi.fn();
  const waits: Array<{ ms: number; resolve(): void }> = [];
  const logs: string[] = [];
  const manager = new SyncManager({
    settings: { get: key => settings.get(key), set: (key, value) => { settings.set(key, value); } },
    identity: () => account,
    connect: options.connect ?? (async () => ({ snapshot: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, close: closed })),
    setSyncing: async (workspaceId, syncing) => { flags.push([workspaceId, syncing]); },
    publish: statuses => { published.push(statuses); },
    open: (async (folder: string) => ({ root: `/real${folder}`, pull })) as unknown as typeof SyncEngine.open,
    wait: (ms, wake) => new Promise<void>(resolve => { waits.push({ ms, resolve }); void wake.promise.then(resolve); }),
    log: line => { logs.push(line); },
  });
  return { logs, manager, settings, flags, published, pull, closed, waits, setAccount: (next: typeof account) => { account = next; }, last: () => published.at(-1) ?? [] };
}

describe("SyncManager", () => {
  it("joins the sync writer before copying an archive and forgets only the completed archive's binding", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({ pull: async () => { entered(); await pending; return { state: "in_sync", problems: [], skipped: [] }; } });
    await f.manager.enable(WS, "/f"); await started;
    const copy = vi.fn(async (_folder: string, _identity: unknown, isCurrent: () => boolean) => { expect(isCurrent()).toBe(true); });
    const archiving = f.manager.archive(WS, copy);
    expect(f.closed).toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(f.manager.folderFor(WS)).toBe("/real/f");
    finish(); await archiving;
    expect(copy).toHaveBeenCalledWith("/real/f", { workspaceId: WS, accountId: "acct-a", deviceId: "22222222-2222-4222-8222-222222222222" }, expect.any(Function));
    expect(f.manager.folderFor(WS)).toBeUndefined();
    expect(f.last()).toEqual([]);
  });

  it("fences an archive while the account changes and preserves a failed copy for retry", async () => {
    const f = fixture();
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.last()[0]?.state).toBe("in_sync"));
    await expect(f.manager.archive(WS, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(f.manager.folderFor(WS)).toBe("/real/f");
    expect(f.last()[0]).toMatchObject({ state: "error", reason: "archive_failed" });
    const copy = vi.fn(async (_folder: string, _identity: unknown, isCurrent: () => boolean) => {
      f.setAccount({ accountId: "acct-b", deviceId: "33333333-3333-4333-8333-333333333333" });
      expect(isCurrent()).toBe(false);
    });
    await f.manager.archive(WS, copy);
    f.setAccount({ accountId: "acct-a", deviceId: "22222222-2222-4222-8222-222222222222" });
    expect(f.manager.folderFor(WS)).toBe("/real/f");
    await f.manager.stop();
  });
  it("turns sync on for a validated folder, flags the Mac, pulls until in sync, and turns off keeping the files", async () => {
    const f = fixture();
    await f.manager.enable(WS, "/Users/alex/w-7");
    expect(f.flags).toEqual([[WS, true]]);
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "in_sync", problems: 0 }]));
    expect(f.manager.folderFor(WS)).toBe("/real/Users/alex/w-7");
    expect([...f.settings.values()][0]).toBe(JSON.stringify({ [WS]: "/real/Users/alex/w-7" }));
    await f.manager.disable(WS);
    expect(f.flags.at(-1)).toEqual([WS, false]);
    expect(f.last()).toEqual([]);
    expect(f.manager.folderFor(WS)).toBeUndefined();
    expect(f.closed).toHaveBeenCalled();
  });

  it("shows Paused while the workspace sleeps and an update error for an old worker, without waking anything", async () => {
    let answer: Error = new SyncConnectError("paused");
    const f = fixture({ connect: async () => { throw answer; } });
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "paused", problems: 0 }]));
    expect(f.waits.at(-1)!.ms).toBe(60_000);
    answer = new SyncConnectError("update_required");
    f.waits.at(-1)!.resolve();
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "error", reason: "update_required", problems: 0 }]));
    expect(f.pull).not.toHaveBeenCalled();
    await f.manager.stop();
  });

  it("pulls again when the worker hints, and reports a stopped inventory as an error", async () => {
    let hint!: () => void;
    const f = fixture({ connect: async (_id, handlers) => { hint = handlers.hint; return { snapshot: async () => { throw new Error(); }, read: async () => { throw new Error(); }, close: () => {} }; } });
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.pull).toHaveBeenCalledTimes(1));
    hint();
    await vi.waitFor(() => expect(f.pull).toHaveBeenCalledTimes(2));
    f.pull.mockResolvedValueOnce({ state: "stopped", problems: [], skipped: [], stopped: "too_many_files" } as never);
    hint();
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "error", reason: "too_many_files", problems: 0 }]));
    await f.manager.stop();
  });

  it("runs only the signed-in account's syncs on this Mac", async () => {
    const f = fixture();
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.last()).toHaveLength(1));
    f.setAccount({ accountId: "acct-b", deviceId: "33333333-3333-4333-8333-333333333333" });
    await f.manager.start();
    expect(f.last()).toEqual([]);
    f.setAccount({ accountId: "acct-a", deviceId: "22222222-2222-4222-8222-222222222222" });
    await f.manager.start();
    await vi.waitFor(() => expect(f.last()).toEqual([expect.objectContaining({ workspaceId: WS })]));
    f.setAccount(null);
    await f.manager.start();
    expect(f.last()).toEqual([]);
  });

  it("logs each run with ids and counts only: started, the pull's kind, files, bytes and duration, git, and every stop with its closed reason", async () => {
    let connects = 0;
    const f = fixture({
      connect: async () => { if (connects++ === 0) throw new SyncConnectError("paused"); return { snapshot: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, close: () => {} }; },
      pull: async () => ({ state: "in_sync", problems: [], skipped: [], git: "ok", stats: { kind: "full", files: 8000, bytes: 123456, deletes: 0 } }) as never,
    });
    await f.manager.enable(WS, "/Users/alex/secret-project");
    await vi.waitFor(() => expect(f.logs.some(line => line.startsWith("paused"))).toBe(true));
    f.waits.at(-1)!.resolve();
    await vi.waitFor(() => expect(f.logs.some(line => line.startsWith("pulled"))).toBe(true));
    const text = f.logs.join("\n");
    expect(f.logs[0]).toMatch(/^started workspace=11111111 resumed=false$/);
    expect(text).toMatch(/^paused workspace=11111111 reason=workspace_stopped$/m);
    expect(text).toMatch(/^reconnect workspace=11111111 attempt=1$/m);
    expect(text).toMatch(/^pulled workspace=11111111 kind=full files=8000 bytes=123456 deletes=0 ms=\d+ git=ok state=in_sync$/m);
    expect(text).not.toMatch(/alex|secret|\//);
    await f.manager.disable(WS);
    expect(f.logs.at(-1)).toBe("stopped workspace=11111111 reason=turned_off");
  });

  it("resumes every synced workspace after an app restart from this Mac's settings, without asking for the folder", async () => {
    const f = fixture();
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "in_sync", problems: 0 }]));
    await f.manager.stop();   // app quit
    const restarted = new SyncManager({ settings: { get: key => f.settings.get(key), set: () => {} }, identity: () => ({ accountId: "acct-a", deviceId: "22222222-2222-4222-8222-222222222222" }),
      connect: async () => ({ snapshot: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, close: () => {} }),
      setSyncing: async () => {}, publish: () => {}, log: () => {},
      open: (async (folder: string) => ({ root: folder, pull: async () => ({ state: "in_sync", problems: [], skipped: [] }) })) as unknown as typeof SyncEngine.open,
      wait: (_ms, wake) => wake.promise });
    await restarted.start();
    await vi.waitFor(() => expect(restarted.statuses()).toEqual([{ workspaceId: WS, state: "in_sync", problems: 0 }]));
    expect(restarted.folderFor(WS)).toBe("/real/f");
    await restarted.stop();
  });

  it("backs off a workspace it cannot reach (2 s doubling to 5 min), says so, turns to an error after 5 failures, and logs each closed reason", async () => {
    const f = fixture({ connect: async () => { throw new SyncConnectError("unavailable", "close_1006"); } });
    await f.manager.enable(WS, "/f");
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      await vi.waitFor(() => expect(f.waits.length).toBe(attempt + 1));
      delays.push(f.waits.at(-1)!.ms);
      if (attempt === 0) expect(f.last()).toEqual([{ workspaceId: WS, state: "paused", reason: "unreachable", problems: 0 }]);
      if (attempt === 4) expect(f.last()).toEqual([{ workspaceId: WS, state: "error", reason: "unreachable", problems: 0 }]);
      f.waits.at(-1)!.resolve();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
    expect(f.logs).toContain("paused workspace=11111111 reason=unavailable detail=close_1006");
    await f.manager.disable(WS);
  });

  it("turns off at once even while a pull is stuck: clears this Mac's entry, says syncing false, and stops showing it", async () => {
    let started!: () => void;
    const pulling = new Promise<void>(resolve => { started = resolve; });
    const f = fixture({ pull: () => { started(); return new Promise(() => {}); } });
    await f.manager.enable(WS, "/f");
    await pulling;
    const off = f.manager.disable(WS);
    await expect(Promise.race([off.then(() => "off"), new Promise(resolve => setTimeout(() => resolve("stuck"), 500))])).resolves.toBe("off");
    expect(f.flags.at(-1)).toEqual([WS, false]);
    expect(f.manager.folderFor(WS)).toBeUndefined();
    expect(f.last()).toEqual([]);
    expect(f.closed).toHaveBeenCalled();
  });
});

describe("SyncManager after this person lost access (team sharing 3A)", () => {
  it("stops syncing for good with its own reason and keeps the folder's files", async () => {
    let connects = 0;
    const f = fixture({ connect: async () => { connects++; throw new SyncConnectError("access_revoked"); } });
    await f.manager.enable(WS, "/f");
    await vi.waitFor(() => expect(f.last()).toEqual([{ workspaceId: WS, state: "error", reason: "access_revoked", problems: 0 }]));
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const wait of f.waits) wait.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(connects).toBe(1);
    expect(f.logs.some(line => line.includes("reason=access_revoked"))).toBe(true);
    expect(f.manager.folderFor(WS)).toBe("/real/f");
  });
});
