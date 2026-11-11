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
  const manager = new SyncManager({
    settings: { get: key => settings.get(key), set: (key, value) => { settings.set(key, value); } },
    identity: () => account,
    connect: options.connect ?? (async () => ({ snapshot: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, close: closed })),
    setSyncing: async (workspaceId, syncing) => { flags.push([workspaceId, syncing]); },
    publish: statuses => { published.push(statuses); },
    open: (async (folder: string) => ({ root: `/real${folder}`, pull })) as unknown as typeof SyncEngine.open,
    wait: (ms, wake) => new Promise<void>(resolve => { waits.push({ ms, resolve }); void wake.promise.then(resolve); }),
  });
  return { manager, settings, flags, published, pull, closed, waits, setAccount: (next: typeof account) => { account = next; }, last: () => published.at(-1) ?? [] };
}

describe("SyncManager", () => {
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
});
