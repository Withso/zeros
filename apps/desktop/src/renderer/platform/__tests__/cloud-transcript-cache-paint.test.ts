import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ native: vi.fn(), allowed: true, confirmed: true, electron: true }));
vi.mock("../runtime", () => ({ isElectron: () => h.electron, nativeInvoke: h.native }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ canReadCloudWorkspace: () => h.allowed,
  cloudWorkspaceCatalogConfirmed: () => h.confirmed, cloudWorkspaceDocument: () => ({ status: "stopped" }) }));
import { readCachedCloudTranscriptWindow, readCloudTranscriptWithCachedPaint, setCloudTranscriptCacheOwner,
  peekCloudTranscriptWindow, forgetRemovedCloudTranscriptWorkspaces } from "../cloud-transcript-cache";
import { cloudScopedId } from "../bridge/cloud-workspace-key";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = cloudScopedId(target, "chat-a");
const window = { recordEpoch: null, revision: 5, cursor: "m-1", messages: [{ msgId: "m-1", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text: "cached", createdAt: 1 }) }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  h.allowed = true; h.confirmed = true; h.electron = true;
  h.native.mockReset().mockImplementation(async (command: string) => command === "cloud_transcript_cache_read"
    ? { cacheEpoch: "33333333-3333-4333-8333-333333333333", window } : undefined);
  setCloudTranscriptCacheOwner("account-a");
});
describe("provisional cloud transcript paint", () => {
  it("paints the primed exact window in a microtask while still awaiting the authoritative read", async () => {
    await readCachedCloudTranscriptWindow(chatId);
    const server = deferred<string>(), painted = vi.fn(); let settled = false;
    const result = readCloudTranscriptWithCachedPaint(chatId, () => server.promise, painted).then(value => { settled = true; return value; });
    expect(painted).not.toHaveBeenCalled(); await Promise.resolve();
    expect(painted).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    server.resolve("new server window"); expect(await result).toBe("new server window");
    expect(h.native.mock.calls.map(call => call[0])).toEqual(["cloud_transcript_cache_read"]);
  });
  it("cannot satisfy a post-prompt authoritative read without the explicit initial-paint callback", async () => {
    await readCachedCloudTranscriptWindow(chatId); h.native.mockClear();
    const server = deferred<string>(); let settled = false;
    const result = readCloudTranscriptWithCachedPaint(chatId, () => server.promise).then(value => { settled = true; return value; });
    await Promise.resolve(); expect(settled).toBe(false); expect(h.native).not.toHaveBeenCalled();
    server.resolve("complete"); expect(await result).toBe("complete");
  });
  it("suppresses a late disk window after the server wins", async () => {
    const disk = deferred<{ cacheEpoch: string; window: typeof window }>(); h.native.mockReturnValueOnce(disk.promise);
    const painted = vi.fn();
    expect(await readCloudTranscriptWithCachedPaint(chatId, async () => "fresh", painted)).toBe("fresh");
    disk.resolve({ cacheEpoch: "33333333-3333-4333-8333-333333333333", window });
    await readCachedCloudTranscriptWindow(chatId); expect(painted).not.toHaveBeenCalled();
  });
  it("requires authenticated ownership and a confirmed readable workspace; Local has no native reads", async () => {
    h.confirmed = false; expect(await readCachedCloudTranscriptWindow(chatId)).toBeNull();
    h.confirmed = true; h.allowed = false; expect(await readCachedCloudTranscriptWindow(chatId)).toBeNull();
    h.allowed = true; setCloudTranscriptCacheOwner(null); expect(await readCachedCloudTranscriptWindow(chatId)).toBeNull();
    setCloudTranscriptCacheOwner("account-a"); expect(await readCachedCloudTranscriptWindow("local-chat")).toBeNull();
    expect(h.native).not.toHaveBeenCalled();
  });
  it("clears removed workspace windows and never releases a cached window into a replacement account", async () => {
    await readCachedCloudTranscriptWindow(chatId); forgetRemovedCloudTranscriptWorkspaces([target.workspaceId]);
    expect(peekCloudTranscriptWindow(chatId)).toBeNull();
    const disk = deferred<{ cacheEpoch: string; window: typeof window }>(); h.native.mockReturnValueOnce(disk.promise);
    const result = readCachedCloudTranscriptWindow(chatId); setCloudTranscriptCacheOwner("account-b"); setCloudTranscriptCacheOwner("account-a");
    disk.resolve({ cacheEpoch: "33333333-3333-4333-8333-333333333333", window });
    expect(await result).toBeNull();
  });
  it("accepts the actual cloud-key catalog removal shape and ignores Local IDs", async () => {
    await readCachedCloudTranscriptWindow(chatId); h.native.mockClear();
    forgetRemovedCloudTranscriptWorkspaces([`cloud://${target.organizationId}/${target.workspaceId}`, "/local/checkout"]);
    expect(peekCloudTranscriptWindow(chatId)).toBeNull();
    expect(h.native).toHaveBeenCalledExactlyOnceWith("cloud_transcript_cache_prune", { accountId: "account-a", ...target });
  });
  it("removes denied cached data immediately, while an ordinary network failure keeps the confirmed cache", async () => {
    await readCachedCloudTranscriptWindow(chatId); const painted = vi.fn();
    await expect(readCloudTranscriptWithCachedPaint(chatId, async () => { throw Object.assign(new Error("denied"), { status: 403 }); }, painted)).rejects.toThrow("denied");
    expect(peekCloudTranscriptWindow(chatId)).toBeNull(); expect(painted).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }));
    await readCachedCloudTranscriptWindow(chatId);
    await expect(readCloudTranscriptWithCachedPaint(chatId, async () => { throw new Error("offline"); }, painted)).rejects.toThrow("offline");
    expect(peekCloudTranscriptWindow(chatId)).not.toBeNull();
  });
});
