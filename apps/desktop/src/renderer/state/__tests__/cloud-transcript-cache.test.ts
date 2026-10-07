import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CloudTranscriptCache } from "../cloud-transcript-cache";

const owner = { accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat-a" };
const epoch = "33333333-3333-4333-8333-333333333333";
const window = (revision = 1) => ({ recordEpoch: null, revision, cursor: "m-1", messages: [{ msgId: "m-1", kind: "text", createdAt: 10,
  payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text: `revision ${revision}`, createdAt: 10 }) }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Dependencies = ConstructorParameters<typeof CloudTranscriptCache>[0];
let allowed: boolean, read: Mock<Dependencies["read"]>, write: Mock<Dependencies["write"]>, prune: Mock<Dependencies["prune"]>, cache: CloudTranscriptCache;
beforeEach(() => {
  allowed = true; read = vi.fn(async () => ({ cacheEpoch: epoch, window: window() })); write = vi.fn(async () => {}); prune = vi.fn(async () => {});
  cache = new CloudTranscriptCache({ isAllowed: () => allowed, read, write, prune }); cache.setAccount(owner.accountId);
});
describe("authorized cloud transcript cache reads", () => {
  it("deduplicates exact reads, restores A → B → A synchronously, and never wakes a runtime", async () => {
    const request = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValueOnce(request.promise);
    const a = cache.read(owner), a2 = cache.read(owner);
    expect(read).toHaveBeenCalledOnce();
    request.resolve({ cacheEpoch: epoch, window: window() });
    expect(await a).toEqual(await a2);
    const b = { ...owner, chatId: "chat-b" }; await cache.read(b);
    expect(cache.peek(owner)?.revision).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.peek({ ...owner, workspaceId: owner.organizationId })).toBeNull();
    expect(cache.peek({ ...owner, organizationId: owner.workspaceId })).toBeNull();
    expect(cache.peek({ ...owner, accountId: "account-b" })).toBeNull();
  });
  it("requires current authorization before disk reads and before exposing a delayed reply", async () => {
    allowed = false; expect(await cache.read(owner)).toBeNull(); expect(read).not.toHaveBeenCalled();
    allowed = true; const pending = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValue(pending.promise);
    const result = cache.read(owner); allowed = false; pending.resolve({ cacheEpoch: epoch, window: window() });
    expect(await result).toBeNull(); expect(cache.peek(owner)).toBeNull();
  });
  it("retires pending reads on account switch/sign-out, including return to the same account", async () => {
    const pending = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValueOnce(pending.promise);
    const result = cache.read(owner); cache.setAccount("account-b"); cache.setAccount(owner.accountId);
    pending.resolve({ cacheEpoch: epoch, window: window() }); expect(await result).toBeNull();
    expect(cache.peek(owner)).toBeNull(); await cache.read(owner); cache.setAccount(null); expect(cache.peek(owner)).toBeNull();
  });
  it("purges exact chat/workspace/organization tombstones and prevents late repopulation", async () => {
    const b = { ...owner, chatId: "chat-b" }; await cache.read(owner); await cache.read(b);
    await cache.prune(owner); expect(cache.peek(owner)).toBeNull(); expect(cache.peek(b)).not.toBeNull();
    const pending = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValueOnce(pending.promise);
    const result = cache.read(owner);
    await cache.prune({ accountId: owner.accountId, organizationId: owner.organizationId, workspaceId: owner.workspaceId });
    pending.resolve({ cacheEpoch: epoch, window: window() }); expect(await result).toBeNull(); expect(cache.peek(b)).toBeNull();
    expect(prune).toHaveBeenCalledTimes(2);
  });
  it("replaces a stale cached window with a newer confirmed revision and refuses late disk regression", async () => {
    const pending = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValueOnce(pending.promise);
    const result = cache.read(owner);
    const confirmed = cache.confirm(owner, window(3));
    expect(cache.peek(owner)?.revision).toBe(3);
    pending.resolve({ cacheEpoch: epoch, window: window(1) });
    expect((await result)?.revision).toBe(3); await confirmed;
    expect(write).toHaveBeenCalledWith(owner, expect.objectContaining({ revision: 3 }), epoch);
    await cache.confirm(owner, window(2)); expect(cache.peek(owner)?.revision).toBe(3);
    expect(write).toHaveBeenCalledOnce();
  });
  it("does not persist a confirmed reply after account retirement or workspace revocation", async () => {
    const pending = deferred<{ cacheEpoch: string; window: null }>(); read.mockReturnValueOnce(pending.promise);
    const result = cache.confirm(owner, window()); cache.setAccount(null); pending.resolve({ cacheEpoch: epoch, window: null });
    await result; expect(write).not.toHaveBeenCalled();
    cache.setAccount(owner.accountId); allowed = false; await cache.confirm(owner, window()); expect(write).not.toHaveBeenCalled();
  });
  it("bounds inactive in-memory windows and leaves Local identities outside the cache", async () => {
    cache = new CloudTranscriptCache({ isAllowed: () => allowed, read, write, prune, maxEntries: 2 }); cache.setAccount(owner.accountId);
    await cache.read(owner); await cache.read({ ...owner, chatId: "b" }); cache.peek(owner); await cache.read({ ...owner, chatId: "c" });
    expect(cache.peek({ ...owner, chatId: "b" })).toBeNull(); expect(cache.peek(owner)).not.toBeNull();
    expect(() => cache.read({ ...owner, workspaceId: "/local/checkout" })).not.toThrow();
    expect(await cache.read({ ...owner, workspaceId: "/organization/checkout" })).toBeNull();
  });
});
