import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ native: vi.fn(), allowed: true }));
vi.mock("../runtime", () => ({ isElectron: () => true, nativeInvoke: h.native }));
vi.mock("../observability/logging/renderer-log", () => ({ logEvent: vi.fn() }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  canReadCloudWorkspace: () => h.allowed,
  cloudWorkspaceCatalogConfirmed: () => true,
  cloudWorkspaceDocument: () => ({ status: "ready" }),
}));

import { CloudTranscriptCacheStore } from "../../../../electron/cloud-transcript-cache-store";
import { cloudScopedId } from "../bridge/cloud-workspace-key";
import { peekCloudTranscriptWindow, readCloudTranscriptWithCachedPaint, setCloudTranscriptCacheOwner } from "../cloud-transcript-cache";
import { prepareCachedTranscriptWindow, type CloudTranscriptOwner, type CloudTranscriptPrune } from "../cloud-transcript-cache-contract";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const owner = { accountId: "account-a", ...target, chatId: "chat-a" };
const chatId = cloudScopedId(target, owner.chatId);
const window = prepareCachedTranscriptWindow({ recordEpoch: null, revision: 3, cursor: "message", messages: [{
  msgId: "message", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "message", kind: "text", role: "agent", text: "Confirmed answer", createdAt: 1 }),
}] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let directory: string;
let disk: CloudTranscriptCacheStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "zeros-transcript-revalidation-"));
  disk = new CloudTranscriptCacheStore(directory);
  disk.write(owner, window);
  h.allowed = true;
  h.native.mockReset().mockImplementation(async (command: string, input: CloudTranscriptOwner | CloudTranscriptPrune) => {
    if (command === "cloud_transcript_cache_read") return {
      cacheEpoch: "33333333-3333-4333-8333-333333333333", ...disk.readReceipt(input as CloudTranscriptOwner),
    };
    if (command === "cloud_transcript_cache_prune") disk.prune(input);
  });
  setCloudTranscriptCacheOwner(owner.accountId);
});
afterEach(() => {
  setCloudTranscriptCacheOwner(null);
  rmSync(directory, { recursive: true, force: true });
});

describe("retained transcript during transient revalidation", () => {
  const failures = [
    Object.assign(new Error("Cloud conversation not found"), { status: 404, code: "cloud_conversation_not_found" }),
    new Error("Cache refresh cancelled"),
    Object.assign(new Error("command_conflict"), { code: "command_conflict" }),
    new Error("No confirmed workspace snapshot is available"),
  ];
  it.each(failures)("paints the disk window when $message rejects before the disk read settles", async error => {
    const gate = deferred<void>();
    const native = h.native.getMockImplementation()!;
    h.native.mockImplementation(async (...args) => { await gate.promise; return native(...args); });
    const painted = vi.fn();
    const result = readCloudTranscriptWithCachedPaint(chatId, async () => { throw error; }, painted);
    // Attach the rejection handler before releasing the deterministic I/O gate.
    const rejected = expect(result).rejects.toBe(error);
    await Promise.resolve();
    const earlyPaints = painted.mock.calls.slice();
    gate.resolve();
    await rejected;
    expect(earlyPaints).toEqual([]);
    expect(painted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messages: window.messages }));
    expect(peekCloudTranscriptWindow(chatId)?.messages).toEqual(window.messages);
    expect(disk.read(owner)?.messages).toEqual(window.messages);
    expect(h.native.mock.calls.some(([command]) => command === "cloud_transcript_cache_prune")).toBe(false);
  });

  it("reopens from the same bounded disk snapshot after repeated projection misses", async () => {
    for (let reopen = 0; reopen < 2; reopen++) {
      setCloudTranscriptCacheOwner(owner.accountId);
      const painted = vi.fn();
      await expect(readCloudTranscriptWithCachedPaint(chatId, async () => { throw failures[0]; }, painted)).rejects.toBe(failures[0]);
      expect(painted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messages: window.messages }));
    }
    expect(new CloudTranscriptCacheStore(directory).read(owner)?.messages).toEqual(window.messages);
  });

  it.each([401, 403, 404])("still retires presentation for a real denied/absent response (%s)", async status => {
    const error = Object.assign(new Error("Unavailable"), { status });
    const painted = vi.fn();
    await expect(readCloudTranscriptWithCachedPaint(chatId, async () => { throw error; }, painted)).rejects.toBe(error);
    expect(peekCloudTranscriptWindow(chatId)).toBeNull();
    expect(painted).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }));
    expect(disk.read(owner)).toBeNull();
  });

  it("rejects a late old-account cache read during A → B → A", async () => {
    const gate = deferred<void>();
    const native = h.native.getMockImplementation()!;
    h.native.mockImplementation(async (...args) => { await gate.promise; return native(...args); });
    const painted = vi.fn();
    const result = readCloudTranscriptWithCachedPaint(chatId, async () => { throw failures[2]; }, painted);
    const rejected = expect(result).rejects.toBe(failures[2]);
    setCloudTranscriptCacheOwner("account-b");
    setCloudTranscriptCacheOwner(owner.accountId);
    gate.resolve(); await rejected;
    expect(painted).not.toHaveBeenCalled();
  });

  it("cannot borrow a sibling chat's disk window or authorize an authoritative read from cached rows", async () => {
    const painted = vi.fn();
    await expect(readCloudTranscriptWithCachedPaint(cloudScopedId(target, "chat-b"), async () => { throw failures[2]; }, painted)).rejects.toBe(failures[2]);
    expect(painted).not.toHaveBeenCalled();
    expect(disk.read(owner)?.messages).toEqual(window.messages);
  });
});
