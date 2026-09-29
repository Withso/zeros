import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient, type CloudPeer } from "../workspace-runtime-client";
import { cloudWorkspaceKey, cloudScopedId, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import type { RuntimeClient } from "../ws-client";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function peer(scope: CloudWorkspaceTarget = target): CloudPeer {
  return {
    client: { status: "connected", on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient,
    scope: { ...scope, root: "/workspace/repo", engineWorkspaceId: "local-main" },
    release: vi.fn(),
  };
}
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });
describe("cloud destination warmup", () => {
  it("reuses stopped history after a normal hover dwell without changing ordinary polling", async () => {
    vi.useFakeTimers();
    const readHistory = vi.fn(async () => ({ chats: [] }));
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, workspaces: () => [] }); clients.push(client);
    await client.warmHistoryWorkspace(target, { intent: true });
    await vi.advanceTimersByTimeAsync(2500);
    await client.warmHistoryWorkspace(target);
    expect(readHistory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    await client.warmHistoryWorkspace(target);
    expect(readHistory).toHaveBeenCalledTimes(2);
  });
  it("bounds admission work even if cancelled native opens have not answered yet", async () => {
    const pending: Array<{ promise: Promise<CloudPeer>; resolve: (peer: CloudPeer) => void }> = [];
    const open = vi.fn(() => { const next = deferred<CloudPeer>(); pending.push(next); return next.promise; });
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], readHistory: async () => ({ chats: [] }) }); clients.push(client);
    const warms: Promise<void>[] = [];
    const targets: CloudWorkspaceTarget[] = [];
    for (let i = 0; i < 24; i++) {
      const t = { ...target, workspaceId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}` }; targets.push(t);
      warms.push(client.warmWorkspace(t, { intent: true }).catch(() => {}));
    }
    const count = open.mock.calls.length;
    for (const [i, read] of pending.entries()) read.resolve(peer(targets[i]));
    await Promise.all(warms);
    expect(count).toBeLessThanOrEqual(16);
  });
  it("shares ready hover and click, then promotes the peer before speculative eviction", async () => {
    vi.useFakeTimers();
    const opened = peer(), open = vi.fn(async () => opened);
    const readHistory = vi.fn(async () => ({ chats: [], chatDeletions: [] }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] }); clients.push(client);
    await Promise.all([client.warmWorkspace(target, { intent: true }), client.warmWorkspace(target)]);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(open).toHaveBeenCalledOnce(); expect(readHistory).toHaveBeenCalledOnce();
    expect(opened.release).not.toHaveBeenCalled();
    client.cancelSpeculativeWarmups(); expect(opened.release).not.toHaveBeenCalled();
  });
  it("bounds speculative peers and closes only those peers when hidden", async () => {
    const peers: CloudPeer[] = [];
    const client = new WorkspaceRuntimeClient({ workspaces: () => [], readHistory: async () => ({ chats: [] }),
      open: async t => { const opened = peer(t); peers.push(opened); return opened; } }); clients.push(client);
    for (let i = 0; i < 6; i++) await client.warmWorkspace({ ...target, workspaceId: `22222222-2222-4222-8222-22222222222${i}` }, { intent: true });
    expect(peers.filter(p => vi.mocked(p.release).mock.calls.length === 0)).toHaveLength(4);
    client.cancelSpeculativeWarmups();
    expect(peers.every(p => vi.mocked(p.release).mock.calls.length === 1)).toBe(true);
  });
  it("deletion cancels a connecting peer and prevents publication of late history", async () => {
    const connecting = deferred<CloudPeer>(), reading = deferred<Record<string, unknown>>();
    let allowed = true; let signal: AbortSignal | undefined;
    const client = new WorkspaceRuntimeClient({ workspaces: () => [], canAccess: () => allowed,
      readHistory: () => reading.promise, open: (_t, opts) => { signal = opts?.signal; return connecting.promise; } }); clients.push(client);
    const warming = client.warmWorkspace(target, { intent: true });
    const rejected = expect(warming).rejects.toThrow(/changed|cancel/i);
    await Promise.resolve(); allowed = false; client.pruneCloudConnections();
    expect(signal?.aborted).toBe(true);
    reading.resolve({ chats: [] }); const opened = peer(); connecting.resolve(opened);
    await rejected;
    expect(opened.release).toHaveBeenCalledOnce();
    expect(client.hasChatSnapshot(cloudWorkspaceKey(target))).toBe(false);
  });
  it("refuses fire-and-forget actions on a connected peer from a stale generation", async () => {
    let identity = "g1"; const opened = peer(); const send = vi.fn(); opened.client.send = send;
    const client = new WorkspaceRuntimeClient({ identity: () => identity, workspaces: () => [], open: async () => opened,
      readHistory: async () => ({ chats: [] }) }); clients.push(client);
    await client.warmWorkspace(target); identity = "g2";
    expect(() => client.send({ type: "AGENT_CANCEL", chatId: cloudScopedId(target, "chat") } as never)).toThrow(/changed/i);
    expect(send).not.toHaveBeenCalled();
  });
  it("publishes independent history while connection is blocked and reuses it after a slow connect", async () => {
    vi.useFakeTimers();
    const connecting = deferred<CloudPeer>();
    const readHistory = vi.fn(async () => ({ chats: [], chatDeletions: [] }));
    const client = new WorkspaceRuntimeClient({ open: () => connecting.promise, workspaces: () => [], readHistory });
    clients.push(client);
    const warm = client.warmWorkspace(target);
    await vi.waitFor(() => expect(client.hasChatSnapshot(cloudWorkspaceKey(target))).toBe(true));
    await vi.advanceTimersByTimeAsync(2500);
    connecting.resolve(peer());
    await warm;
    expect(readHistory).toHaveBeenCalledTimes(1);
  });
  it("does not reuse an opening peer or history across a generation change", async () => {
    const old = deferred<CloudPeer>();
    let generation = "account-a:g1";
    const open = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(peer());
    const readHistory = vi.fn(async () => ({ chats: [], chatDeletions: [] }));
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], readHistory, identity: () => generation });
    clients.push(client);
    const first = client.warmWorkspace(target);
    const rejected = expect(first).rejects.toThrow(/changed|cancel/i);
    await Promise.resolve();
    generation = "account-a:g2";
    const second = client.warmWorkspace(target);
    const retired = peer();
    old.resolve(retired);
    await rejected;
    await second;
    expect(open).toHaveBeenCalledTimes(2);
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(retired.release).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight open immediately on sign-out", async () => {
    const connecting = deferred<CloudPeer>();
    let signal: AbortSignal | undefined;
    const client = new WorkspaceRuntimeClient({
      open: (_target, options) => { signal = options?.signal; return connecting.promise; }, workspaces: () => [],
    });
    clients.push(client);
    const warm = client.warmWorkspace(target);
    const rejected = expect(warm).rejects.toThrow(/changed|cancel/i);
    client.clearCloudConnections();
    expect(signal?.aborted).toBe(true);
    const retired = peer();
    connecting.resolve(retired);
    await rejected;
    expect(retired.release).toHaveBeenCalledOnce();
  });
});
