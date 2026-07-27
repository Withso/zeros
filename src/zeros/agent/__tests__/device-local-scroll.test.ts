// device-local scroll positions — persistence, v1→v2 migration + pruning.
// Node-env: window/localStorage are stubbed per test; the module is
// deliberately tolerant of their absence (reads → empty, writes → no-op).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadScrollPositions,
  pruneScrollPositions,
  saveScrollPosition,
} from "../device-local";

function stubLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

describe("device-local scroll positions", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = stubLocalStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips anchored positions per chat", () => {
    saveScrollPosition("chat-a", {
      top: 120,
      anchorId: "m1",
      anchorOffset: 40,
    });
    saveScrollPosition("chat-b", { top: 999, atBottom: true });
    expect(loadScrollPositions()).toEqual({
      "chat-a": { top: 120, anchorId: "m1", anchorOffset: 40 },
      "chat-b": { top: 999, atBottom: true },
    });
  });

  it("migrates legacy v1 bare-number offsets on read", () => {
    storage.setItem(
      "zeros.chat-scroll.v1",
      JSON.stringify({ "old-chat": 420, junk: "nope" }),
    );
    expect(loadScrollPositions()).toEqual({ "old-chat": { top: 420 } });
  });

  it("first v2 write carries the v1 entries forward, then v1 is ignored", () => {
    storage.setItem(
      "zeros.chat-scroll.v1",
      JSON.stringify({ "old-chat": 420 }),
    );
    // Read-modify-write migrates the legacy doc into v2 alongside the save.
    saveScrollPosition("new-chat", { top: 7 });
    expect(loadScrollPositions()).toEqual({
      "old-chat": { top: 420 },
      "new-chat": { top: 7 },
    });
    // Once a v2 doc exists, later v1 mutations are invisible.
    storage.setItem("zeros.chat-scroll.v1", JSON.stringify({ ghost: 999 }));
    expect(loadScrollPositions()).toEqual({
      "old-chat": { top: 420 },
      "new-chat": { top: 7 },
    });
  });

  it("drops corrupt entries instead of surfacing them", () => {
    storage.setItem(
      "zeros.chat-scroll.v2",
      JSON.stringify({
        ok: { top: 10 },
        negative: { top: -4 },
        nonsense: { anchorId: "x" },
      }),
    );
    expect(loadScrollPositions()).toEqual({ ok: { top: 10 } });
  });

  it("prunes offsets for chats missing from the authoritative list", () => {
    saveScrollPosition("kept", { top: 10 });
    saveScrollPosition("archived-kept", { top: 20 });
    saveScrollPosition("deleted", { top: 30 });
    pruneScrollPositions(new Set(["kept", "archived-kept"]));
    expect(loadScrollPositions()).toEqual({
      kept: { top: 10 },
      "archived-kept": { top: 20 },
    });
  });

  it("never mass-prunes on an empty valid set (transient boot hiccup)", () => {
    saveScrollPosition("chat-a", { top: 42 });
    pruneScrollPositions(new Set());
    expect(loadScrollPositions()).toEqual({ "chat-a": { top: 42 } });
  });

  it("tolerates a missing window (non-browser harness)", () => {
    vi.unstubAllGlobals();
    expect(loadScrollPositions()).toEqual({});
    expect(() => saveScrollPosition("x", { top: 1 })).not.toThrow();
    expect(() => pruneScrollPositions(new Set(["x"]))).not.toThrow();
  });
});
