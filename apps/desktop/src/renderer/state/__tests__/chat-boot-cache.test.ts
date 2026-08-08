import { beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../../platform/settings";
import { loadCachedChatsForBoot, sanitizeCachedChat } from "../chat-boot-cache";
import {
  CHATS_BACKUP_KEY,
  CHATS_STORAGE_KEY,
  CHATS_TOMBSTONE_KEY,
} from "../chats-local-cache";

beforeEach(() => {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
});

describe("synchronous chat boot cache", () => {
  it("preserves every current effort and permission value", () => {
    const chat = sanitizeCachedChat({
      id: "chat-1",
      folder: "/workspace",
      agentId: "codex",
      agentName: "Codex",
      model: "gpt-5",
      effort: "ultracode",
      permissionMode: "danger",
      fast: true,
      additionalDirectories: [" /one ", "/one", "", 42, "/two"],
      title: "Work",
      createdAt: 10,
      updatedAt: 20,
    });

    expect(chat).toMatchObject({
      effort: "ultracode",
      permissionMode: "danger",
      fast: true,
      additionalDirectories: ["/one", "/two"],
    });
  });

  it("migrates legacy fields without guessing an agent before registry load", () => {
    expect(
      sanitizeCachedChat({
        id: "legacy",
        effort: "max",
        permissionMode: "ask",
        resumeSessionId: "session-1",
      }),
    ).toMatchObject({
      agentId: null,
      effort: "max",
      permissionMode: "tool-approval",
      sessionId: "session-1",
    });
  });

  it("defaults a missing legacy effort to High with Fast off", () => {
    expect(sanitizeCachedChat({ id: "legacy-defaults" })).toMatchObject({
      agentId: null,
      effort: "high",
      fast: false,
    });
  });

  it("treats blank cached agent and model identities as unbound", () => {
    expect(
      sanitizeCachedChat({
        id: "blank-identities",
        agentId: "   ",
        model: "",
      }),
    ).toMatchObject({ agentId: null, model: null });
  });

  it("restores a valid backup only when no intentional-empty tombstone exists", () => {
    const backup = [{ id: "backup", title: "Recovered" }];
    setSetting(CHATS_STORAGE_KEY, []);
    setSetting(CHATS_BACKUP_KEY, backup);
    expect(loadCachedChatsForBoot().map((chat) => chat.id)).toEqual(["backup"]);

    setSetting(CHATS_STORAGE_KEY, []);
    setSetting(CHATS_TOMBSTONE_KEY, true);
    expect(loadCachedChatsForBoot()).toEqual([]);
  });

  it("drops malformed and duplicate rows without failing the whole boot", () => {
    setSetting(CHATS_STORAGE_KEY, [
      null,
      { id: "good" },
      { id: "good", title: "duplicate" },
      { title: "missing id" },
    ]);
    expect(loadCachedChatsForBoot().map((chat) => chat.id)).toEqual(["good"]);
  });
});
