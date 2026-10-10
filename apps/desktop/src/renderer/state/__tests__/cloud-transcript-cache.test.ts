import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CloudTranscriptCache, CloudHistoryRestoreTracker } from "../cloud-transcript-cache";

const owner = { accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat-a" };
const epoch = "33333333-3333-4333-8333-333333333333";
const window = (revision = 1) => ({ recordEpoch: null, revision, cursor: "m-1", messages: [{ msgId: "m-1", kind: "text", createdAt: 10,
  payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text: `revision ${revision}`, createdAt: 10 }) }] });
const projection = { organizationId: owner.organizationId, workspaceId: owner.workspaceId, generation: 2,
  engineInstanceId: epoch, bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
  fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1,
  version: 1 as const, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const,
  mirroredSequence: 20, sealedSequence: null, complete: false };
const fence = { projection, conversationId: owner.chatId, head: { conversationId: owner.chatId,
  originWriterEpoch: projection.writerEpoch, source: { kind: "mutation" as const, mutationId: epoch, operation: "repair" as const },
  restoreRevision: 5, deleted: false, recordSequence: null, eventSequence: 4, manifestSha256: null,
  incompleteReason: "history_limit" as const } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Dependencies = ConstructorParameters<typeof CloudTranscriptCache>[0];
let allowed: boolean, read: Mock<Dependencies["read"]>, write: Mock<Dependencies["write"]>, prune: Mock<Dependencies["prune"]>, cache: CloudTranscriptCache;
beforeEach(() => {
  allowed = true; read = vi.fn(async () => ({ cacheEpoch: epoch, window: window() })); write = vi.fn(async () => {}); prune = vi.fn(async () => {});
  cache = new CloudTranscriptCache({ isAllowed: () => allowed, read, write, prune }); cache.setAccount(owner.accountId);
});
describe("authorized cloud transcript cache reads", () => {
  it("keeps the CP writer fence after a failed durable prune instead of promoting an old disk writer", async () => {
    const disk = { ...fence, projection: { ...projection, generation: 1,
      writerEpoch: "88888888-8888-4888-8888-888888888888" },
      head: { ...fence.head, restoreRevision: 1000, recordSequence: 1, manifestSha256: "a".repeat(64), incompleteReason: null } };
    read.mockResolvedValue({ cacheEpoch: epoch, historyEpoch: epoch, restoreHead: disk,
      window: { ...window(1000), restoreHead: disk } });
    expect(await cache.read(owner)).not.toBeNull();
    prune.mockRejectedValueOnce(new Error("Synthetic optional cache I/O failure"));
    await cache.installRestoreHead(owner, fence);
    expect(await cache.read(owner)).toBeNull();
    expect(cache.restoreHead(owner)).toEqual(fence);
    await cache.confirm(owner, { ...window(1001), restoreHead: disk });
    expect(write).not.toHaveBeenCalled();
  });
  it("does not let a disk repair replace an independently confirmed incomplete CP head", async () => {
    const disk = { ...fence, head: { ...fence.head, restoreRevision: 6,
      recordSequence: 2, manifestSha256: "a".repeat(64), incompleteReason: null } };
    read.mockResolvedValue({ cacheEpoch: epoch, historyEpoch: epoch, restoreHead: disk,
      window: { ...window(1000), restoreHead: disk } });
    prune.mockRejectedValueOnce(new Error("Synthetic optional cache I/O failure"));
    await cache.installRestoreHead(owner, fence);
    expect(await cache.read(owner)).toBeNull();
    expect(cache.restoreHead(owner)).toEqual(fence);
  });
  it("retires old confirmations and paint before the durable incomplete-head fence is acknowledged", async () => {
    await cache.read(owner);
    const sibling = { ...owner, chatId: "sibling" }; await cache.read(sibling);
    const old = cache.captureConfirmation(owner)!;
    const pending = deferred<void>(); prune.mockReturnValueOnce(pending.promise);
    const installing = cache.installRestoreHead(owner, fence);
    expect(cache.peek(owner)).toBeNull();
    expect(cache.peek(sibling)).not.toBeNull();
    await old(window(1000));
    expect(write).not.toHaveBeenCalled();
    pending.resolve(); await installing;
    expect(prune).toHaveBeenCalledWith(expect.objectContaining({ ...owner, restoreHead: fence }));
  });
  it("does not publish a delayed disk result through a newer unknown or deleted restore head", async () => {
    const pending = deferred<{ cacheEpoch: string; window: ReturnType<typeof window> }>(); read.mockReturnValueOnce(pending.promise);
    const old = cache.read(owner);
    const installing = cache.installRestoreHead(owner, { ...fence, head: null });
    pending.resolve({ cacheEpoch: epoch, window: window(1000) });
    await installing;
    expect(await old).toBeNull(); expect(cache.peek(owner)).toBeNull();
  });
  it("serializes durable head writes for one chat while sibling heads progress independently", async () => {
    const historyEpoch = "77777777-7777-4777-8777-777777777777";
    read.mockResolvedValue({ cacheEpoch: epoch, historyEpoch, window: null });
    const pending = deferred<void>(); prune.mockReturnValueOnce(pending.promise);
    const first = cache.installRestoreHead(owner, fence);
    await Promise.resolve(); await Promise.resolve();
    const newer = { ...fence, head: { ...fence.head, restoreRevision: 6 } };
    const second = cache.installRestoreHead(owner, newer);
    const sibling = { ...owner, chatId: "sibling" };
    await cache.installRestoreHead(sibling, { ...fence, conversationId: sibling.chatId,
      head: { ...fence.head, conversationId: sibling.chatId } });
    expect(prune).toHaveBeenCalledTimes(2);
    expect(cache.restoreHead(owner)).toEqual(newer);
    pending.resolve(); await first; await second;
    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: owner.chatId, restoreHead: newer }));
  });
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

describe("exact stopped-history read ownership", () => {
  const scope = { accountId: owner.accountId, organizationId: owner.organizationId, workspaceId: owner.workspaceId };
  const metadata = { projection, historyHeads: [fence.head] };
  const complete = { ...metadata, historyHeads: [{ ...fence.head, restoreRevision: 4, incompleteReason: null,
    recordSequence: 1, manifestSha256: "a".repeat(64) }] };
  it("rejects an older result after a newer incomplete head while keeping a sibling read valid", () => {
    const tracker = new CloudHistoryRestoreTracker(); tracker.setAccount(owner.accountId);
    const old = tracker.capture(scope)!, sibling = tracker.capture(scope)!;
    tracker.install(tracker.capture(scope)!, metadata, [owner.chatId]);
    expect(() => tracker.assertResult(old, complete, [owner.chatId])).toThrow(/restore|retired/u);
    expect(() => tracker.assertResult(old, null, [owner.chatId])).toThrow(/restore|retired/u);
    const siblingMetadata = { projection, historyHeads: [{ ...complete.historyHeads[0]!, conversationId: "sibling" }] };
    tracker.install(sibling, siblingMetadata, ["sibling"]);
    expect(() => tracker.assertResult(sibling, siblingMetadata, ["sibling"])).not.toThrow();
  });
  it("fences pending former-binding reads and account A→B→A without comparing unrelated restore revisions", () => {
    const tracker = new CloudHistoryRestoreTracker(); tracker.setAccount(owner.accountId);
    const initial = tracker.capture(scope)!; tracker.install(initial, complete, [owner.chatId]);
    const old = tracker.capture(scope)!;
    const next = { projection: { ...projection, writerEpoch: "88888888-8888-4888-8888-888888888888", generation: 3 },
      historyHeads: [{ ...metadata.historyHeads[0]!, restoreRevision: 1 }] };
    tracker.install(tracker.capture(scope)!, next, [owner.chatId]);
    expect(() => tracker.install(old, complete, [owner.chatId])).toThrow(/retired/u);
    expect(() => tracker.assertResult(old, complete, [owner.chatId])).toThrow(/retired/u);
    tracker.setAccount("account-b"); tracker.setAccount(owner.accountId);
    expect(() => tracker.install(old, next, [owner.chatId])).toThrow(/retired/u);
  });
  it("keeps missing coverage unknown and permits only a matching verified later repair", () => {
    const tracker = new CloudHistoryRestoreTracker(); tracker.setAccount(owner.accountId);
    const ticket = tracker.capture(scope)!;
    tracker.install(ticket, { projection, historyHeads: [] }, [owner.chatId]);
    expect(tracker.head(scope, owner.chatId)?.head).toBeNull();
    expect(() => tracker.assertResult(ticket, complete, [owner.chatId])).toThrow(/restore/u);
    tracker.install(tracker.capture(scope)!, complete, [owner.chatId]);
    expect(() => tracker.assertResult(tracker.capture(scope)!, complete, [owner.chatId])).not.toThrow();
    expect(() => tracker.install(tracker.capture(scope)!, { ...complete,
      historyHeads: [{ ...complete.historyHeads[0]!, source: { ...fence.head.source, operation: "edit" } }] }, [owner.chatId])).toThrow(/conflict/u);
  });
  it("fences every retained former-binding conversation when one page establishes the new writer", () => {
    const tracker = new CloudHistoryRestoreTracker(); tracker.setAccount(owner.accountId);
    const siblingHead = { ...complete.historyHeads[0]!, conversationId: "sibling" };
    tracker.install(tracker.capture(scope)!, { ...complete, historyHeads: [...complete.historyHeads, siblingHead] });
    const changed = { projection: { ...projection, writerEpoch: "88888888-8888-4888-8888-888888888888", generation: 3 },
      historyHeads: [{ ...metadata.historyHeads[0]!, restoreRevision: 1 }] };
    tracker.install(tracker.capture(scope)!, changed, [owner.chatId]);
    expect(tracker.head(scope, "sibling")).toEqual({ projection: changed.projection, conversationId: "sibling", head: null });
  });
});
