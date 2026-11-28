import { describe, expect, it, vi } from "vitest";
import {
  createMemoryLocalQueueJournal,
  localQueuedPrompt,
  restoredLocalQueue,
  serialized,
  type LocalQueuedPrompt,
} from "../local-queue-journal";

const prompt = (bubbleId: string, text = bubbleId): LocalQueuedPrompt => ({ bubbleId, text, createdAt: 1 });

describe("Local queue journal", () => {
  it("replaces a chat's saved queue and removes it when empty", async () => {
    const journal = createMemoryLocalQueueJournal();
    await journal.write("chat", [prompt("a"), prompt("b")]);
    await journal.write("chat", [prompt("b")]);
    expect((await journal.read("chat")).map(entry => entry.bubbleId)).toEqual(["b"]);
    await journal.write("chat", []);
    expect(await journal.read("chat")).toEqual([]);
  });

  it("applies one chat's writes in call order even when an earlier write is slow", async () => {
    let releaseFirst!: () => void;
    const rows = new Map<string, LocalQueuedPrompt[]>();
    const journal = serialized({
      read: async chatId => rows.get(chatId) ?? [],
      write: async (chatId, entries) => {
        if (entries[0]?.bubbleId === "old") await new Promise<void>(resolve => { releaseFirst = resolve; });
        rows.set(chatId, entries);
      },
    });
    const first = journal.write("chat", [prompt("old")]);
    const second = journal.write("chat", [prompt("new")]);
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    releaseFirst();
    await Promise.all([first, second]);
    expect((await journal.read("chat")).map(entry => entry.bubbleId)).toEqual(["new"]);
  });

  it("never returns a queue past its retention, so reading cannot renew its age", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const journal = createMemoryLocalQueueJournal();
      await journal.write("chat", [prompt("old")]);
      vi.setSystemTime(new Date("2026-02-05T00:00:00Z"));
      expect(await journal.read("chat")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("returns copies, so later edits to a restored entry do not change the saved one", async () => {
    const journal = createMemoryLocalQueueJournal();
    await journal.write("chat", [prompt("a", "saved")]);
    const [entry] = await journal.read("chat");
    entry!.text = "edited";
    expect((await journal.read("chat"))[0]?.text).toBe("saved");
  });
});

describe("Local queued prompt conversion", () => {
  it("keeps exactly the payload sendPrompt needs, with the bubble's time", () => {
    const saved = localQueuedPrompt(
      { bubbleId: "q1", args: ["chat", "wire text", "shown text", undefined, [], [], "fix-ci", () => {}] },
      [{ id: "q1", kind: "text", role: "user", text: "shown text", createdAt: 42 }],
    );
    expect(saved).toEqual({ bubbleId: "q1", createdAt: 42, text: "wire text", displayText: "shown text", autoAction: "fix-ci" });
  });

  it("restores only entries the chat does not already show, as paused queue rows", () => {
    const { entries, bubbles } = restoredLocalQueue("chat", [
      prompt("sent"),
      { ...prompt("q1", "follow up"), displayText: "follow up" },
      { ...prompt("q2", "<context_handoff>…"), autoAction: undefined },
    ], new Set(["sent"]));
    expect(entries.map(entry => entry.args.slice(0, 3))).toEqual([["chat", "follow up", "follow up"], ["chat", "<context_handoff>…", undefined]]);
    expect(bubbles).toMatchObject([
      { id: "q1", role: "user", text: "follow up", queued: true, queuedEditable: true },
      { id: "q2", queued: true, queuedEditable: false },
    ]);
  });
});
