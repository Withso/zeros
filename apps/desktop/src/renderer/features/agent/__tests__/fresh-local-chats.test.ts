import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  storage.clear();
});

const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

/** A fresh module instance reads only what an earlier "launch" persisted. */
async function launch() {
  vi.resetModules();
  return import("../fresh-local-chats");
}

describe("known-empty Local chats", () => {
  it("survive a restart until the chat shows any history", async () => {
    const first = await launch();
    first.rememberEmptyLocalChat("chat-empty", "/repo");
    first.rememberEmptyLocalChat("chat-cloud", CLOUD);
    expect(first.isKnownEmptyLocalChat("chat-empty")).toBe(true);
    expect(first.isKnownEmptyLocalChat("chat-cloud")).toBe(false);

    const second = await launch();
    expect(second.isKnownEmptyLocalChat("chat-empty")).toBe(true);
    second.forgetEmptyLocalChat("chat-empty");

    const third = await launch();
    expect(third.isKnownEmptyLocalChat("chat-empty")).toBe(false);
  });

  it("includes chats this renderer mints, and the fresh mark is still consumed once", async () => {
    const first = await launch();
    first.markFreshLocalChat("chat-new", "/organization/repo");
    expect(first.consumeFreshLocalChat("chat-new")).toBe(true);
    expect(first.consumeFreshLocalChat("chat-new")).toBe(false);
    const second = await launch();
    expect(second.isKnownEmptyLocalChat("chat-new")).toBe(true);
    // Delete and reset forget both marks.
    second.forgetFreshLocalChat("chat-new");
    expect(second.isKnownEmptyLocalChat("chat-new")).toBe(false);
  });

  it("stays bounded, prunes to the confirmed chat list and ignores malformed storage", async () => {
    const first = await launch();
    for (let index = 0; index < 300; index += 1) first.rememberEmptyLocalChat(`chat-${index}`, "/repo");
    expect(first.isKnownEmptyLocalChat("chat-0")).toBe(false);
    expect(first.isKnownEmptyLocalChat("chat-299")).toBe(true);
    first.retainKnownEmptyLocalChats((chatId) => chatId !== "chat-299");
    const second = await launch();
    expect(second.isKnownEmptyLocalChat("chat-299")).toBe(false);
    expect(second.isKnownEmptyLocalChat("chat-298")).toBe(true);

    for (const key of storage.keys()) storage.set(key, JSON.stringify({ not: "a list" }));
    const third = await launch();
    expect(third.isKnownEmptyLocalChat("chat-298")).toBe(false);
  });
});
