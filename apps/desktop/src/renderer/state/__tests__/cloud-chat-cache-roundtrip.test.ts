import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudChatCacheStore } from "../../../../electron/cloud-chat-cache/store";
import { CloudChatCacheService, type CloudChatCacheSource } from "../../../../electron/cloud-chat-cache/service";
import { createCloudChatCacheCommand } from "../../../../electron/cloud-chat-cache/commands";
import { NativeCloudChatCacheClient } from "../../platform/cloud-chat-cache-client";
import { LocalTranscriptCache, decodeNativeCloudTranscriptWindow } from "../local-transcript-cache";
import { createNativeCloudTranscriptCache } from "../cloud-native-transcript-cache";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const chatId = `cloud:${target.organizationId}:${target.workspaceId}:chat`, folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const message = { id: "message", kind: "text" as const, role: "user" as const, text: "Saved native row", createdAt: 1 };
const row = { index: 0, msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: 1 };
const stops: Array<() => void> = [], roots: string[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-cache-roundtrip-")); roots.push(root); return root;
}
function fixture(root: string, offline = false, channelBytes = 2 * 1024 ** 3) {
  const source: CloudChatCacheSource = {
    workspace: vi.fn(async () => {
      if (offline) return new Promise<{ id: string; organizationId: string }>(() => {});
      return { id: target.workspaceId, organizationId: target.organizationId };
    }),
    range: vi.fn(async (_key, fromIndex, toIndex) => ({ revision: 7, messageCount: 1, fromIndex, toIndex,
      rows: toIndex > fromIndex ? [row] : [] })),
    since: vi.fn(async () => ({ resync: false, fromRevision: 7, revision: 7, messageCount: 1, rows: [] })),
    pending: vi.fn(async () => ({ queueRevision: 1, epoch: "0", items: [] })),
  };
  let readOrder = 0;
  const store = new CloudChatCacheStore(root, { limits: { channelBytes }, now: () => ++readOrder });
  const service = new CloudChatCacheService({ store, source, identity: () => ({ owner, session: "same-sign-in" }) });
  const command = createCloudChatCacheCommand({ service: async () => service, admit: () => ({ window: 1, current: () => true }) });
  const native = new NativeCloudChatCacheClient({ invoke: request => command(request, undefined) });
  native.bindOwner(owner, "same-sign-in");
  const cache = createNativeCloudTranscriptCache(LocalTranscriptCache, native, decodeNativeCloudTranscriptWindow);
  cache.bindOwner(owner, false);
  const close = () => { cache.resetForTesting(); native.bindOwner(null); service.close(); store.close(); };
  stops.push(close);
  return { source, store, service, native, cache, close };
}

describe("native cloud cache from renderer through main to SQLite", () => {
  it("keeps the selected chat through real SQLite eviction after main invalidates its lease", async () => {
    const f = fixture(directory(), false, 1_200);
    await f.native.protect(target);
    await f.native.refresh(target);
    f.service.sessionChanged();
    await expect(f.native.refresh(target)).rejects.toMatchObject({ reason: "owner_changed" });
    await f.native.refresh(target);
    const saved = { revision: 7, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [row] };
    for (const chatId of ["background-one", "background-two", "background-three"])
      expect(f.store.putRange({ owner, ...target, chatId }, saved)).toBe(true);
    expect(f.store.readTail({ owner, ...target })?.rows).toEqual([row]);
    expect(f.store.bytes()).toBeLessThanOrEqual(1_200);
  });

  it("reopens a cached transcript through IPC while every passive network read stays held", async () => {
    const root = directory(), first = fixture(root);
    await first.native.refresh(target); first.close();
    const next = fixture(root, true);
    const cached = await next.cache.read(chatId);
    expect(cached).toMatchObject({ messages: [message], source: "control-plane", cloudCache: { owner, revision: 7 } });
    expect(next.cache.peek(chatId)).toBe(cached);
    await vi.waitFor(() => expect(next.source.workspace).toHaveBeenCalledTimes(1));
    expect(next.source.range).not.toHaveBeenCalled();
  });

  it("stores the passive native mirror after worker settlement while retaining live renderer content", async () => {
    const root = directory(), first = fixture(root);
    const live = { ...message, text: "Live worker content" };
    first.cache.remember(chatId, folder, { messages: [live], leadingPrompt: null, source: "worker" });
    await vi.waitFor(() => expect(first.store.metadata({ owner, ...target })?.revision).toBe(7));
    expect(first.store.readTail({ owner, ...target })?.rows).toEqual([row]);
    expect(first.cache.peek(chatId)?.messages[0]).toBe(live);
    first.close();
    expect((await fixture(root, true).cache.read(chatId))?.messages).toEqual([message]);
  });
});
