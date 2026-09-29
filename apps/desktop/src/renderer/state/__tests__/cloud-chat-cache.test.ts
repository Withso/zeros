import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "../../platform/settings";
import { loadCloudChatCache, persistWorkspaceChatCache, setCloudChatCacheOwner } from "../cloud-chat-cache";
import { sanitizeCachedChat } from "../chat-boot-cache";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  setCloudChatCacheOwner(null);
});
afterEach(() => { setCloudChatCacheOwner(null); vi.unstubAllGlobals(); });

it("does not replace the cloud boot cache with Local-only state while authorization is pending", () => {
  const cloud = sanitizeCachedChat({ id: "cloud-chat", folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" })!;
  setSetting("cloud-chats:v1", { owner: "account-a", chats: [cloud] });
  setCloudChatCacheOwner("account-a");
  expect(loadCloudChatCache()).toEqual([cloud]);
  persistWorkspaceChatCache("chats-v1", [sanitizeCachedChat({ id: "local", folder: "/repo" })!]);
  expect(getSetting("cloud-chats:v1", null)).toEqual({ owner: "account-a", chats: [cloud] });
});

it("does not release another account's cloud conversations", () => {
  setSetting("cloud-chats:v1", { owner: "account-a", chats: [{ id: "private", folder: "cloud://private" }] });
  setCloudChatCacheOwner("account-b");
  expect(loadCloudChatCache()).toEqual([]);
});
