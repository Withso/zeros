import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "../../platform/settings";
import { completeCloudChatCacheRestore, loadCloudChatCache, persistWorkspaceChatCache, setCloudChatCacheOwner } from "../cloud-chat-cache";
import { accountPresentationOwner, CLOUD_CHATS_PRESENTATION_KEY, writeAccountPresentation } from "../../platform/account-presentation-cache";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { sanitizeCachedChat } from "../chat-boot-cache";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  setCloudChatCacheOwner(null);
});
afterEach(() => { setCloudChatCacheOwner(null); vi.unstubAllGlobals(); });

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const owner = accountPresentationOwner("https://api.example.test", "account-a");
const cloud = sanitizeCachedChat({ id: cloudScopedId(target, "chat"), folder: cloudWorkspaceKey(target) })!;

it("does not replace the cloud boot cache with Local-only state while identity restoration is pending", () => {
  writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner, [cloud], 1024 * 1024);
  setCloudChatCacheOwner(owner);
  expect(loadCloudChatCache()).toEqual([cloud]);
  persistWorkspaceChatCache("chats-v1", [sanitizeCachedChat({ id: "local", folder: "/repo" })!]);
  expect(loadCloudChatCache()).toEqual([cloud]);
});

it("does not release another account's cloud conversations", () => {
  writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner, [cloud], 1024 * 1024);
  setCloudChatCacheOwner(accountPresentationOwner("https://api.example.test", "account-b"));
  expect(loadCloudChatCache()).toEqual([]);
});

it("isolates the same account on a different backend", () => {
  writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner, [cloud], 1024 * 1024);
  setCloudChatCacheOwner(accountPresentationOwner("https://other.example.test", "account-a"));
  expect(loadCloudChatCache()).toEqual([]);
});

it("rejects legacy unfenced metadata and cross-organization native IDs", () => {
  setSetting("cloud-chats:v1", { owner: "account-a", chats: [cloud] });
  setCloudChatCacheOwner(owner);
  expect(getSetting("cloud-chats:v1", null)).toBeNull();
  expect(loadCloudChatCache()).toEqual([]);
  const foreign = { ...cloud, id: cloudScopedId({ ...target, organizationId: "33333333-3333-4333-8333-333333333333" }, "chat") };
  writeAccountPresentation(CLOUD_CHATS_PRESENTATION_KEY, owner, [foreign, cloud], 1024 * 1024);
  expect(loadCloudChatCache()).toEqual([cloud]);
});

it("writes bounded cloud metadata only after restore while preserving Local cache rows", () => {
  setCloudChatCacheOwner(owner);
  completeCloudChatCacheRestore(owner);
  const local = sanitizeCachedChat({ id: "local", folder: "/repo" })!;
  const many = Array.from({ length: 550 }, (_, index) => ({ ...cloud, id: cloudScopedId(target, String(index)) }));
  persistWorkspaceChatCache("chats-v1", [local, ...many]);
  expect(getSetting("chats-v1", [])).toEqual([local]);
  expect(loadCloudChatCache()).toHaveLength(512);
});

it("retains the selected older cloud tab inside the metadata bound", () => {
  setCloudChatCacheOwner(owner);
  completeCloudChatCacheRestore(owner);
  const many = Array.from({ length: 550 }, (_, index) => ({ ...cloud, id: cloudScopedId(target, String(index)) }));
  persistWorkspaceChatCache("chats-v1", many, undefined, many[0]!.id);
  expect(loadCloudChatCache().some(chat => chat.id === many[0]!.id)).toBe(true);
  expect(loadCloudChatCache()).toHaveLength(512);
});

it("does not resurrect an older chat snapshot when its replacement exceeds the byte bound", () => {
  setCloudChatCacheOwner(owner);
  completeCloudChatCacheRestore(owner);
  persistWorkspaceChatCache("chats-v1", [cloud]);
  expect(loadCloudChatCache()).toEqual([cloud]);
  const replacement = { ...cloud, id: cloudScopedId(target, "replacement"), title: "x".repeat(1024 * 1024) };
  persistWorkspaceChatCache("chats-v1", [replacement]);
  expect(loadCloudChatCache().some(chat => chat.id === cloud.id)).toBe(false);
});
