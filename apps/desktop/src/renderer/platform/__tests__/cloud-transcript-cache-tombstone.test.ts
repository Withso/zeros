import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn(), native: vi.fn() }));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: h.request }));
vi.mock("../runtime", () => ({ isElectron: () => true, nativeInvoke: h.native }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0 }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ canReadCloudWorkspace: () => true,
  cloudWorkspaceCatalogConfirmed: () => true, cloudWorkspaceDocument: () => ({ status: "stopped" }) }));

import { CloudTranscriptCacheStore } from "../../../../electron/cloud-transcript-cache-store";
import { readCloudWorkspaceHistory } from "../cloud-history";
import { peekCloudTranscriptWindow, setCloudTranscriptCacheOwner, forgetRemovedCloudTranscriptWorkspaces,
  onCloudHistoryRestoreHead } from "../cloud-transcript-cache";
import { cloudScopedId, cloudWorkspaceKey } from "../bridge/cloud-workspace-key";
import type { CachedTranscriptWindow, CloudTranscriptOwner, CloudTranscriptPrune } from "../cloud-transcript-cache-contract";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const epoch = "33333333-3333-4333-8333-333333333333";
const owner = (chatId: string) => ({ accountId: "account-a", ...target, chatId });
const id = (chatId: string) => cloudScopedId(target, chatId);
const messagePage = (text = "before tombstone") => ({ ...target, revision: 1, messages: [{ msgId: "m-1", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text, createdAt: 1 }) }] });
const deletionPage = { ...target, revision: 2, chats: [{ id: "chat-b", folder: "." }], chatDeletions: ["chat-a"], nextCursor: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let directory: string, store: CloudTranscriptCacheStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "zeros-history-tombstone-"));
  store = new CloudTranscriptCacheStore(directory);
  h.request.mockReset();
  h.native.mockReset().mockImplementation(async (command: string, args: CloudTranscriptOwner & { window?: CachedTranscriptWindow }) => {
    const key = { accountId: args.accountId, organizationId: args.organizationId, workspaceId: args.workspaceId, chatId: args.chatId };
    if (command === "cloud_transcript_cache_read") return { cacheEpoch: epoch, ...store.readReceipt(key) };
    if (command === "cloud_transcript_cache_write") store.write(key, args.window, (args as { historyEpoch?: string }).historyEpoch);
    if (command === "cloud_transcript_cache_prune") {
      store.prune(args as CloudTranscriptPrune);
      if ((args as CloudTranscriptPrune).restoreHead) return { cacheEpoch: epoch, ...store.readReceipt(key) };
    }
  });
  setCloudTranscriptCacheOwner("account-a");
});
afterEach(() => { setCloudTranscriptCacheOwner(null); rmSync(directory, { recursive: true, force: true }); });
const writes = () => h.native.mock.calls.filter(call => call[0] === "cloud_transcript_cache_write");

describe("HTTP history confirmation versus durable cache tombstones", () => {
  it.each(["incomplete", "deleted"] as const)("rejects a late former head after %s and preserves the fence through disk reload", async kind => {
    const projection = { ...target, generation: 2, engineInstanceId: epoch, bootId: "44444444-4444-4444-8444-444444444444",
      writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
      fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10,
      sealedSequence: null, complete: false };
    const head = { conversationId: "chat-a", originWriterEpoch: projection.writerEpoch,
      source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "repair" },
      restoreRevision: 1, deleted: false, recordSequence: 4, eventSequence: 9, manifestSha256: "a".repeat(64), incompleteReason: null };
    const complete = { ...messagePage(), projection, historyHeads: [head] };
    const observed = vi.fn(), stopObserved = onCloudHistoryRestoreHead(observed);
    h.request.mockResolvedValueOnce(complete);
    await readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a") }); await flush();
    stopObserved(); expect(observed).toHaveBeenCalledWith(id("chat-a"), expect.objectContaining({ head }), "control-plane");
    expect(store.read(owner("chat-a"))?.restoreHead?.head).toEqual(head);
    const old = deferred<typeof complete>(); h.request.mockReturnValueOnce(old.promise);
    const delayed = readCloudWorkspaceHistory(target, "messages.windowOlder", { chatId: id("chat-a"), beforeMsgId: "m-1" });
    const latest = { ...head, restoreRevision: 2, source: { ...head.source, operation: kind === "deleted" ? "delete" : "edit" },
      deleted: kind === "deleted", manifestSha256: kind === "incomplete" ? null : head.manifestSha256,
      incompleteReason: kind === "incomplete" ? "history_limit" : null, recordSequence: kind === "incomplete" ? null : 5 };
    h.request.mockResolvedValueOnce({ ...target, revision: 2, chats: [], chatDeletions: [], nextCursor: null,
      projection: { ...projection, mirroredSequence: 20 }, historyHeads: [latest] });
    await readCloudWorkspaceHistory(target, "chats.list", {});
    expect(peekCloudTranscriptWindow(id("chat-a"))).toBeNull();
    old.resolve(complete); await expect(delayed).rejects.toThrow(/restore|retired/u);
    const reopened = new CloudTranscriptCacheStore(directory);
    expect(reopened.read(owner("chat-a"))).toBeNull();
    expect(reopened.readReceipt(owner("chat-a")).restoreHead?.head).toEqual(latest);
    h.request.mockRejectedValueOnce(Object.assign(new Error("Synthetic offline"), { status: 503 }));
    await expect(readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a") })).rejects.toThrow("Synthetic offline");
    expect(peekCloudTranscriptWindow(id("chat-a"))).toBeNull();
    const repair = { ...head, restoreRevision: 3, recordSequence: 1 };
    h.request.mockResolvedValueOnce({ ...messagePage("verified repair"), projection: { ...projection, mirroredSequence: 30 }, historyHeads: [repair] });
    await readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a") }); await flush();
    expect(new CloudTranscriptCacheStore(directory).read(owner("chat-a"))?.messages[0]?.payload).toContain("verified repair");
  });
  it("cannot recreate memory or disk when an older history GET resolves after a newer chat-list tombstone", async () => {
    const old = deferred<ReturnType<typeof messagePage>>();
    h.request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(deletionPage);
    const result = readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a"), limit: 200 });
    expect(h.native).not.toHaveBeenCalled();
    expect(await readCloudWorkspaceHistory(target, "chats.list", {})).toMatchObject({ revision: 2, chatDeletions: [id("chat-a")] });
    expect(peekCloudTranscriptWindow(id("chat-a"))).toBeNull(); expect(store.read(owner("chat-a"))).toBeNull();
    old.resolve(messagePage()); await result; await flush();
    expect({ memory: peekCloudTranscriptWindow(id("chat-a"))?.revision ?? null,
      disk: new CloudTranscriptCacheStore(directory).read(owner("chat-a"))?.revision ?? null, writes: writes().length })
      .toEqual({ memory: null, disk: null, writes: 0 });
  });
  it("still confirms and persists a sibling pending GET when the newer list tombstones only the other chat", async () => {
    const a = deferred<ReturnType<typeof messagePage>>(), b = deferred<ReturnType<typeof messagePage>>();
    h.request.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockResolvedValueOnce(deletionPage);
    const aRead = readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a"), limit: 200 });
    const bRead = readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-b"), limit: 200 });
    await readCloudWorkspaceHistory(target, "chats.list", {});
    a.resolve(messagePage()); b.resolve(messagePage("readable sibling")); await Promise.all([aRead, bRead]); await flush();
    expect(writes().map(call => call[1].chatId)).toEqual(["chat-b"]);
    expect(peekCloudTranscriptWindow(id("chat-a"))).toBeNull();
    const cached = peekCloudTranscriptWindow(id("chat-b"));
    expect(cached?.messages.map(row => JSON.parse(row.payload)))
      .toEqual(messagePage("readable sibling").messages.map(row => JSON.parse(row.payload)));
    const restarted = new CloudTranscriptCacheStore(directory);
    expect(restarted.read(owner("chat-a"))).toBeNull(); expect(restarted.read(owner("chat-b"))).toEqual(cached);
  });
  it.each(["workspace removal", "account A → B → A"])("fences a pre-request confirmation across %s even while the workspace is readable again", async retirement => {
    const old = deferred<ReturnType<typeof messagePage>>(); h.request.mockReturnValueOnce(old.promise);
    const result = readCloudWorkspaceHistory(target, "messages.window", { chatId: id("chat-a"), limit: 200 });
    if (retirement === "workspace removal") forgetRemovedCloudTranscriptWorkspaces([cloudWorkspaceKey(target)]);
    else { setCloudTranscriptCacheOwner("account-b"); setCloudTranscriptCacheOwner("account-a"); }
    old.resolve(messagePage());
    if (retirement === "account A → B → A") await expect(result).rejects.toThrow(/retired/u);
    else await result;
    await flush();
    expect(writes()).toHaveLength(0); expect(peekCloudTranscriptWindow(id("chat-a"))).toBeNull();
    expect(new CloudTranscriptCacheStore(directory).read(owner("chat-a"))).toBeNull();
  });
});
