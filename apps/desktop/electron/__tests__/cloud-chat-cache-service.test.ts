import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudChatCacheStore } from "../cloud-chat-cache/store";
import { CloudChatCacheService, CloudCacheAccessLost, type CloudChatCacheSource } from "../cloud-chat-cache/service";
import type { CloudCacheRange, CloudCachePending } from "../../shared/cloud-chat-cache";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const otherOwner = JSON.stringify(["https://api.example.test", "viewer-b"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const row = (index: number, text = `row ${index}`) => ({ index, msgId: `m-${index}`, kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: `m-${index}`, kind: "text", role: "agent", text, createdAt: 1 }) });
const page = (revision = 1): CloudCacheRange => ({ revision, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [row(0)] });
const receipts = (queueRevision = 1): CloudCachePending => ({ queueRevision, epoch: "2", items: [{
  receipt: { workspaceId: target.workspaceId, chatId: target.chatId, userMessageId: "pending-1", sequence: "1", epoch: "2",
    acceptedAt: "2026-11-12T12:00:00.000Z", workspaceState: "stopped" }, state: "queued", cancelRequested: false,
  payload: { chatId: target.chatId, userMessageId: "pending-1", agentId: "codex", prompt: [{ type: "text", text: "saved prompt" }], startedAt: 1 },
}] });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-chat-cache-service-"));
  const store = new CloudChatCacheStore(directory);
  let identity: { owner: string; session: string } | null = { owner, session: "a" };
  const source: CloudChatCacheSource = {
    workspace: vi.fn(async () => ({ organizationId: target.organizationId, id: target.workspaceId })),
    range: vi.fn(async (_target, fromIndex, toIndex) => ({ ...page(), fromIndex, toIndex, rows: toIndex ? [row(0)] : [] })),
    since: vi.fn(async (_target, revision) => ({ resync: false, fromRevision: revision, revision, messageCount: 1, rows: [] })),
    pending: vi.fn(async () => receipts()),
  };
  const service = new CloudChatCacheService({ store, source, identity: () => identity });
  cleanups.push(() => { service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const binding = service.bind(1, owner, "renderer-1");
  return { store, service, source, binding,
    switchTo: (next: typeof identity) => { identity = next; service.sessionChanged(); },
  };
}

describe("main cloud cache admission and refresh", () => {
  it("a refresh for a newer known revision never joins a flight started for an older one", async () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, page(1));
    const first = held<void>(), started = held<void>();
    vi.mocked(f.source.since).mockImplementationOnce(async () => { started.resolve(); await first.promise;
      return { resync: false, fromRevision: 1, revision: 2, messageCount: 2, rows: [row(1)] }; })
      .mockImplementationOnce(async () => ({ resync: false, fromRevision: 2, revision: 3, messageCount: 3, rows: [row(2)] }));
    const older = f.service.refresh(1, f.binding, target, 200, { revision: 2, messageCount: 2 });
    await started.promise;
    const newer = f.service.refresh(1, f.binding, target, 200, { revision: 3, messageCount: 3 });
    first.resolve();
    expect((await older).range.revision).toBe(2);
    expect((await newer).range.revision).toBe(3);
    expect(f.source.since).toHaveBeenCalledTimes(2);
  });

  it("a Team-shared chat whose revision matches opens with its senders and zero requests", async () => {
    const f = fixture(), key = { owner, ...target }, alice = { userId: "44444444-4444-4444-8444-444444444444" };
    const prompt = { index: 0, msgId: "p", kind: "text", createdAt: 1, payload: JSON.stringify({ id: "p", kind: "text", role: "user", text: "Hi", createdAt: 1 }) };
    f.store.putRange(key, { revision: 5, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [prompt], senders: { p: alice } });
    const hit = await f.service.refresh(1, f.binding, target, 200, { revision: 5, messageCount: 1 });
    expect(hit.range.senders).toEqual({ p: alice });
    for (const fn of [f.source.workspace, f.source.range, f.source.since, f.source.pending]) expect(fn).not.toHaveBeenCalled();
  });

  it("a chat whose chats.list revision matches the cache opens with no network read; a changed one continues once", async () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, page(3));
    const counts = () => [f.source.workspace, f.source.range, f.source.since, f.source.pending].map(fn => vi.mocked(fn).mock.calls.length);
    const hit = await f.service.refresh(1, f.binding, target, 200, { revision: 3, messageCount: 1 });
    expect(hit).toEqual({ range: page(3), replaced: false, cached: true });
    expect(counts()).toEqual([0, 0, 0, 0]);
    vi.mocked(f.source.since).mockImplementationOnce(async () => ({ resync: false, fromRevision: 3, revision: 4, messageCount: 2, rows: [row(1)] }));
    const changed = await f.service.refresh(1, f.binding, target, 200, { revision: 4, messageCount: 2 });
    expect(changed.range.rows).toEqual([row(0), row(1)]);
    // The chats.list read that carried the revision already proved access: one continuation, no workspace read.
    expect(counts()).toEqual([0, 0, 1, 0]);
  });

  it("keeps receipt snapshots separately from history and joins their refresh across windows", async () => {
    const f = fixture(); f.store.putRange({ owner, ...target }, page());
    const pending = held<CloudCachePending>(), started = held<void>();
    vi.mocked(f.source.pending).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const secondBinding = f.service.bind(2, owner, "renderer-2");
    const first = f.service.refreshPending(1, f.binding, target);
    const second = f.service.refreshPending(2, secondBinding, target);
    await started.promise;
    expect(f.service.readPending(1, f.binding, target)).toBeNull();
    f.service.release(1);
    pending.resolve(receipts(4));
    await expect(first).rejects.toThrow("changed");
    expect(await second).toEqual(receipts(4));
    expect(f.service.readPending(2, secondBinding, target)).toEqual(receipts(4));
    expect(f.source.pending).toHaveBeenCalledTimes(1);
    expect(f.service.read(2, secondBinding, target, 200)?.rows).toEqual([row(0)]);
  });

  it("does not resurrect forgotten or retired receipt snapshots from a late reply", async () => {
    for (const retire of [false, true]) {
      const f = fixture(); f.store.putRange({ owner, ...target }, page());
      const pending = held<CloudCachePending>(), started = held<void>();
      vi.mocked(f.source.pending).mockImplementation(async () => { started.resolve(); return pending.promise; });
      const refresh = f.service.refreshPending(1, f.binding, target);
      await started.promise;
      if (retire) f.service.retireOwner(owner, "a"); else f.service.forget(1, f.binding, target);
      pending.resolve(receipts());
      await expect(refresh).rejects.toThrow("changed");
      expect(f.store.readPending({ owner, ...target })).toBeNull();
    }
  });

  it("preserves the last receipt snapshot on an old server or transient failure and erases confirmed access loss", async () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, page()); f.store.putPending(key, receipts());
    vi.mocked(f.source.pending).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new CloudCacheAccessLost());
    expect(await f.service.refreshPending(1, f.binding, target)).toBeNull();
    expect(f.service.readPending(1, f.binding, target)).toEqual(receipts());
    await expect(f.service.refreshPending(1, f.binding, target)).rejects.toThrow();
    expect(f.service.readPending(1, f.binding, target)).toEqual(receipts());
    await expect(f.service.refreshPending(1, f.binding, target)).rejects.toBeInstanceOf(CloudCacheAccessLost);
    expect(f.service.readPending(1, f.binding, target)).toBeNull();
    expect(f.service.read(1, f.binding, target, 200)).toBeNull();
  });

  it("returns a durable cached window before a held server refresh completes", async () => {
    const f = fixture();
    f.store.putRange({ owner, ...target }, page());
    const pending = held<Awaited<ReturnType<CloudChatCacheSource["since"]>>>(), started = held<void>();
    vi.mocked(f.source.since).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const refresh = f.service.refresh(1, f.binding, target, 200);
    await started.promise;
    expect(f.service.read(1, f.binding, target, 200)?.rows).toEqual([row(0)]);
    pending.resolve({ resync: false, fromRevision: 1, revision: 2, messageCount: 1, rows: [row(0, "edited")] });
    expect((await refresh).range.rows).toEqual([row(0, "edited")]);
    expect(f.store.readTail({ owner, ...target })?.revision).toBe(2);
  });

  it("pages saved history offline only within the exact revision and contiguous segment", () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, { revision: 5, messageCount: 12, fromIndex: 0, toIndex: 4,
      rows: [row(0), row(1), row(2), row(3)] });
    f.store.putRange(key, { revision: 5, messageCount: 12, fromIndex: 6, toIndex: 12,
      rows: [row(6), row(7), row(8), row(9), row(10), row(11)] });
    expect(f.service.readBefore(1, f.binding, target, 5, "m-9", 3)?.rows).toEqual([row(6), row(7), row(8)]);
    expect(f.service.readBefore(1, f.binding, target, 4, "m-9", 3)).toBeNull();
    expect(f.service.readBefore(1, f.binding, target, 5, "m-6", 3)).toBeNull();
    expect(f.service.readBefore(1, f.binding, target, 5, "missing", 3)).toBeNull();
    expect(f.service.readBefore(1, f.binding, target, 5, "m-0", 3)?.rows).toEqual([]);
    expect(f.source.workspace).not.toHaveBeenCalled();
    expect(f.source.range).not.toHaveBeenCalled();
    expect(f.source.since).not.toHaveBeenCalled();
  });

  it("caches a requested older live range only when the server still has the saved revision", async () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, { revision: 7, messageCount: 5, fromIndex: 3, toIndex: 5, rows: [row(3), row(4)] });
    vi.mocked(f.source.range).mockImplementation(async (_target, fromIndex, toIndex) => ({
      revision: 7, messageCount: 5, fromIndex, toIndex, rows: Array.from({ length: toIndex - fromIndex }, (_, i) => row(fromIndex + i)),
    }));
    expect((await f.service.refreshBefore(1, f.binding, target, "m-3", 2))?.rows).toEqual([row(1), row(2)]);
    expect(f.source.range).toHaveBeenCalledWith(key, 1, 3, expect.anything());
    expect(f.service.readBefore(1, f.binding, target, 7, "m-3", 2)?.rows).toEqual([row(1), row(2)]);
    vi.mocked(f.source.range).mockResolvedValue({ revision: 8, messageCount: 5, fromIndex: 0, toIndex: 1, rows: [row(0, "changed")] });
    expect(await f.service.refreshBefore(1, f.binding, target, "m-1", 2)).toBeNull();
    expect(f.store.metadata(key)?.revision).toBe(7);
    expect(f.service.readBefore(1, f.binding, target, 7, "m-1", 2)).toBeNull();
  });

  it("a history resync retires a receipt refresh begun under the previous lineage", async () => {
    const f = fixture(), key = { owner, ...target };
    f.store.putRange(key, page());
    const pending = held<CloudCachePending>(), started = held<void>();
    vi.mocked(f.source.pending).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const refresh = f.service.refreshPending(1, f.binding, target);
    await started.promise;
    vi.mocked(f.source.since).mockResolvedValue({ resync: true, revision: 2, messageCount: 1 });
    vi.mocked(f.source.range).mockResolvedValue(page(2));
    await f.service.refresh(1, f.binding, target, 200);
    pending.resolve(receipts());
    await expect(refresh).rejects.toThrow("changed");
    expect(f.store.readPending(key)).toBeNull();
    expect(f.store.metadata(key)?.revision).toBe(2);
  });

  it("derives the account from main and refuses a renderer choosing another owner", () => {
    const f = fixture();
    f.store.putRange({ owner: otherOwner, ...target }, page());
    expect(() => f.service.bind(2, otherOwner, "renderer-2")).toThrow();
    expect(f.service.read(1, f.binding, target, 200)).toBeNull();
  });

  it("rejects a response across A to B to A even when the original account session returns", async () => {
    const f = fixture(), pending = held<CloudCacheRange>(), started = held<void>();
    vi.mocked(f.source.range).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const refresh = f.service.refresh(1, f.binding, target, 200);
    await started.promise;
    f.switchTo({ owner: otherOwner, session: "b" }); f.switchTo({ owner, session: "a" });
    const next = f.service.bind(1, owner, "renderer-2");
    pending.resolve({ ...page(), fromIndex: 0, toIndex: 0, rows: [] });
    await expect(refresh).rejects.toThrow("changed");
    expect(f.service.read(1, next, target, 200)).toBeNull();
    expect(f.source.range).toHaveBeenCalledTimes(1);
  });

  it("joins duplicate passive refreshes and does not return cache rows as a failed authoritative read", async () => {
    const f = fixture(), pending = held<never>(), started = held<void>();
    f.store.putRange({ owner, ...target }, page());
    vi.mocked(f.source.workspace).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const first = f.service.refresh(1, f.binding, target, 200);
    const second = f.service.refresh(1, f.binding, target, 200);
    expect(second).toBe(first);
    await started.promise;
    f.service.forget(1, f.binding, target);
    pending.resolve({ organizationId: target.organizationId, id: target.workspaceId } as never);
    await expect(first).rejects.toThrow("changed");
    expect(f.service.read(1, f.binding, target, 200)).toBeNull();
  });

  it("keeps offline data on a network failure but erases it on confirmed loss of access", async () => {
    const f = fixture(); f.store.putRange({ owner, ...target }, page());
    vi.mocked(f.source.workspace).mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.refresh(1, f.binding, target, 200)).rejects.toThrow();
    expect(f.service.read(1, f.binding, target, 200)).not.toBeNull();
    vi.mocked(f.source.workspace).mockRejectedValueOnce(new CloudCacheAccessLost());
    await expect(f.service.refresh(1, f.binding, target, 200)).rejects.toBeInstanceOf(CloudCacheAccessLost);
    expect(f.service.read(1, f.binding, target, 200)).toBeNull();
  });

  it("never stores a workspace's history under a different organization", async () => {
    const f = fixture();
    vi.mocked(f.source.workspace).mockResolvedValue({ id: target.workspaceId, organizationId: "33333333-3333-4333-8333-333333333333" });
    await expect(f.service.refresh(1, f.binding, target, 200)).rejects.toThrow();
    expect(f.source.range).not.toHaveBeenCalled();
    expect(f.service.read(1, f.binding, target, 200)).toBeNull();
  });

  it("drops a replaced lineage and refetches the newest contiguous range", async () => {
    const f = fixture(); f.store.putRange({ owner, ...target }, page());
    vi.mocked(f.source.since).mockResolvedValue({ resync: true, revision: 4, messageCount: 2 });
    vi.mocked(f.source.range).mockImplementation(async (_target, fromIndex, toIndex) => {
      expect(f.store.readTail({ owner, ...target })).toBeNull();
      return { revision: 4, messageCount: 2, fromIndex, toIndex, rows: [row(0, "replacement"), row(1)] };
    });
    const reply = await f.service.refresh(1, f.binding, target, 200);
    expect(reply.range.rows).toEqual([row(0, "replacement"), row(1)]);
    expect(reply.replaced).toBe(true);
    expect(f.source.range).toHaveBeenCalledTimes(1);
  });

  it("retiring a parked account removes only that viewing account and fences its old replies", () => {
    const f = fixture();
    f.store.putRange({ owner, ...target }, page()); f.store.putRange({ owner: otherOwner, ...target }, page());
    f.service.retireOwner(otherOwner);
    expect(f.store.readTail({ owner: otherOwner, ...target })).toBeNull();
    expect(f.service.read(1, f.binding, target, 200)).not.toBeNull();
    f.service.retireOwner(owner);
    expect(() => f.service.read(1, f.binding, target, 200)).toThrow("changed");
    expect(f.store.readTail({ owner, ...target })).toBeNull();
  });

  it("a late retirement of an older sign-in preserves the replacement session's cache", () => {
    const f = fixture();
    f.store.putRange({ owner, ...target }, page());
    f.switchTo({ owner, session: "a-new" });
    const next = f.service.bind(1, owner, "renderer-new");
    expect(f.service.read(1, next, target, 200)).toBeNull();
    f.store.putRange({ owner, ...target }, page(2));
    f.service.retireOwner(owner, "a");
    expect(f.service.read(1, next, target, 200)?.revision).toBe(2);
    f.service.retireOwner(owner, "a-new");
    expect(() => f.service.read(1, next, target, 200)).toThrow("changed");
    expect(f.store.readTail({ owner, ...target })).toBeNull();
  });

  it("a late denial cannot erase a later successful refresh after forget", async () => {
    const f = fixture(), started = held<void>();
    let reject!: (error: Error) => void;
    const old = new Promise<never>((_resolve, fail) => { reject = fail; });
    vi.mocked(f.source.workspace).mockImplementationOnce(async () => { started.resolve(); return old; });
    const first = f.service.refresh(1, f.binding, target, 200);
    await started.promise;
    f.service.forget(1, f.binding, target);
    expect((await f.service.refresh(1, f.binding, target, 200)).range.rows).toEqual([row(0)]);
    reject(new CloudCacheAccessLost());
    await expect(first).rejects.toThrow("changed");
    expect(f.service.read(1, f.binding, target, 200)?.rows).toEqual([row(0)]);
  });

  it("fences every window that joins a refresh when its own binding changes", async () => {
    const f = fixture(), pending = held<Awaited<ReturnType<CloudChatCacheSource["since"]>>>(), started = held<void>();
    f.store.putRange({ owner, ...target }, page());
    vi.mocked(f.source.since).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const secondBinding = f.service.bind(2, owner, "renderer-2");
    const first = f.service.refresh(1, f.binding, target, 200);
    const second = f.service.refresh(2, secondBinding, target, 200);
    const secondResult = expect(second).rejects.toThrow("changed");
    await started.promise;
    f.service.bind(2, owner, "replacement-renderer-2");
    pending.resolve({ resync: false, fromRevision: 1, revision: 2, messageCount: 1, rows: [row(0, "new")] });
    expect((await first).range.rows).toEqual([row(0, "new")]);
    await secondResult;
    expect(f.source.since).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared refresh alive while another window still needs its result", async () => {
    const f = fixture(), pending = held<Awaited<ReturnType<CloudChatCacheSource["since"]>>>(), started = held<void>();
    f.store.putRange({ owner, ...target }, page());
    vi.mocked(f.source.since).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const secondBinding = f.service.bind(2, owner, "renderer-2");
    const first = f.service.refresh(1, f.binding, target, 200);
    const firstResult = expect(first).rejects.toThrow("changed");
    const second = f.service.refresh(2, secondBinding, target, 200);
    await started.promise;
    f.service.release(1);
    pending.resolve({ resync: false, fromRevision: 1, revision: 2, messageCount: 1, rows: [row(0, "new")] });
    expect((await second).range.rows).toEqual([row(0, "new")]);
    await firstResult;
    expect(f.source.since).toHaveBeenCalledTimes(1);
  });

  it("a superseded window-size read cannot erase the next successful read", async () => {
    const f = fixture(), started = held<void>();
    let reject!: (error: Error) => void;
    const old = new Promise<never>((_resolve, fail) => { reject = fail; });
    vi.mocked(f.source.workspace).mockImplementationOnce(async () => { started.resolve(); return old; });
    const first = f.service.refresh(1, f.binding, target, 50);
    const firstResult = expect(first).rejects.toThrow("changed");
    await started.promise;
    expect((await f.service.refresh(1, f.binding, target, 200)).range.rows).toEqual([row(0)]);
    reject(new CloudCacheAccessLost());
    await firstResult;
    expect(f.service.read(1, f.binding, target, 200)?.rows).toEqual([row(0)]);
  });
});
