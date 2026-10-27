import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSummaryWire } from "../agent-history-client";

const engine = vi.hoisted(() => ({
  calls: [] as Array<{ folder: string; excludeChatId?: string }>,
  rows: new Map<string, ChatSummaryWire[]>(),
}));
vi.mock("../agent-history-client", () => ({
  listChatSummariesForFolder: vi.fn(async (args: { folder: string; excludeChatId?: string }) => {
    engine.calls.push(args);
    return (engine.rows.get(args.folder) ?? []).filter((row) => row.chatId !== args.excludeChatId);
  }),
}));

const storage = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  engine.calls.length = 0;
  engine.rows.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  storage.clear();
});

const row = (chatId: string, folder: string, count = 1, at = 10): ChatSummaryWire => ({
  chatId, title: "Untitled", folder, summary: `prompt ${chatId}`, summaryAt: 0,
  agentId: "claude", agentName: "Claude", userMessageCount: count, lastMessageAt: at,
});
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

async function fresh() {
  vi.resetModules();
  return import("../use-chat-transcript-summaries");
}

describe("Local chat transcript summaries", () => {
  it("shares one engine list per folder and filters exclusions locally for either placement", async () => {
    const summaries = await fresh();
    expect(summaries.chatTranscriptSummariesKey("/repo", "chat-a"))
      .toBe(summaries.chatTranscriptSummariesKey("/repo", "chat-b"));
    expect(summaries.chatTranscriptSummariesKey("/repo/a", "x")).not.toBe(summaries.chatTranscriptSummariesKey("/repo", "a/x"));
    expect(summaries.chatTranscriptSummariesKey(CLOUD, "chat-a")).toBe(summaries.chatTranscriptSummariesKey(CLOUD, "chat-b"));

    engine.rows.set("/repo", [row("chat-a", "/repo"), row("chat-b", "/repo")]);
    summaries.warmChatTranscriptSummaries("/repo", "chat-a");
    summaries.warmChatTranscriptSummaries("/repo", "chat-b");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    // One unfiltered read; each chat drops itself locally.
    expect(engine.calls[0]).toEqual({ folder: "/repo" });
    expect(summaries.visibleTranscriptSummaries("/repo", engine.rows.get("/repo")!, "chat-a").map((r) => r.chatId))
      .toEqual(["chat-b"]);
  });

  it("paints the persisted list on the next launch before the engine answers", async () => {
    vi.useFakeTimers();
    const first = await fresh();
    engine.rows.set("/repo", [row("chat-a", "/repo")]);
    first.warmChatTranscriptSummaries("/repo", "chat-new");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(storage.size).toBeGreaterThan(0);

    const relaunched = await fresh();
    // A brand-new tab in that folder paints the list in its first render.
    expect(relaunched.transcriptSummariesSnapshotForTesting("/repo", "another-new-tab"))
      .toMatchObject({ loading: false, data: [expect.objectContaining({ chatId: "chat-a" })] });
    expect(engine.calls).toHaveLength(1);
    // The persisted folder decodes, validated, without a read.
    const saved = relaunched.decodePersistedTranscriptSummaries(
      JSON.parse([...storage.values()].find((value) => value.includes("chat-a"))!),
    );
    expect(saved.get("/repo")?.rows.map((r) => r.chatId)).toEqual(["chat-a"]);
    // Malformed or cloud entries are dropped, never thrown.
    expect(relaunched.decodePersistedTranscriptSummaries([{ folder: CLOUD, updatedAt: 1, rows: [] }, { nope: true }, 3]).size).toBe(0);
    // The persisted list is paint-only: the first mount still asks the engine.
    relaunched.warmChatTranscriptSummaries("/repo", "another-new-tab");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
  });

  it("shows a prompt sent from this renderer at once, then yields to the engine's row", async () => {
    const summaries = await fresh();
    const t0 = Date.now();
    summaries.noteLocalChatPrompt({ chatId: "chat-new", folder: "/repo", text: "research this project", title: "Untitled",
      agentId: "codex", agentName: "Codex", at: t0 });
    // Another empty chat in the folder sees it immediately; the sender never sees itself.
    expect(summaries.visibleTranscriptSummaries("/repo", [], "chat-empty").map((r) => [r.chatId, r.summary, r.userMessageCount]))
      .toEqual([["chat-new", "research this project", 1]]);
    expect(summaries.visibleTranscriptSummaries("/repo", [], "chat-new")).toEqual([]);
    // Other folders and cloud are untouched.
    expect(summaries.visibleTranscriptSummaries("/other", [], "x")).toEqual([]);
    summaries.noteLocalChatPrompt({ chatId: "cloud-chat", folder: CLOUD, text: "hi", at: t0 });
    expect(summaries.visibleTranscriptSummaries(CLOUD, [], "x")).toEqual([]);

    // An engine read from before the prompt was persisted does not erase it.
    const before = [row("chat-old", "/repo", 1, t0 - 5_000)];
    expect(summaries.visibleTranscriptSummaries("/repo", before, "chat-empty").map((r) => r.chatId))
      .toEqual(["chat-new", "chat-old"]);
    // Once the engine reports it, the engine row wins and the pending row is gone.
    engine.rows.set("/repo", [row("chat-new", "/repo", 1, t0), ...before]);
    summaries.warmChatTranscriptSummaries("/repo", "chat-empty");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(summaries.visibleTranscriptSummaries("/repo", [], "chat-empty")).toEqual([]));
  });

  it("drops deleted chats from cached, persisted and pending rows", async () => {
    vi.useFakeTimers();
    const summaries = await fresh();
    engine.rows.set("/repo", [row("chat-a", "/repo"), row("chat-gone", "/repo")]);
    summaries.warmChatTranscriptSummaries("/repo", "chat-new");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    summaries.noteLocalChatPrompt({ chatId: "chat-gone-too", folder: "/repo", text: "hi" });
    const keep = new Set(["chat-a", "chat-new"]);
    summaries.retainTranscriptSummaries((chatId) => keep.has(chatId));
    expect(summaries.transcriptSummariesSnapshotForTesting("/repo", "chat-new").data?.map((r) => r.chatId))
      .toEqual(["chat-a"]);
    expect(summaries.visibleTranscriptSummaries("/repo", [], "chat-new")).toEqual([]);
    summaries.flushPersistedTranscriptSummaries();
    const saved = summaries.decodePersistedTranscriptSummaries(
      JSON.parse([...storage.values()].find((value) => value.includes("chat-a"))!),
    );
    expect(saved.get("/repo")?.rows.map((r) => r.chatId)).toEqual(["chat-a"]);
  });

  it("counts a later prompt on a known chat, and expires an unconfirmed one", async () => {
    const summaries = await fresh();
    const t0 = Date.now();
    const known = [row("chat-a", "/repo", 2, t0 - 60_000)];
    engine.rows.set("/repo", known);
    summaries.warmChatTranscriptSummaries("/repo", "chat-empty");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    summaries.noteLocalChatPrompt({ chatId: "chat-a", folder: "/repo", text: "again", at: t0 });
    expect(summaries.visibleTranscriptSummaries("/repo", known, "chat-empty")[0])
      .toMatchObject({ chatId: "chat-a", userMessageCount: 3, lastMessageAt: t0 });
    summaries.noteLocalChatPrompt({ chatId: "chat-a", folder: "/repo", text: "third", at: t0 + 1 });
    expect(summaries.visibleTranscriptSummaries("/repo", known, "chat-empty")[0].userMessageCount).toBe(4);
    // A send that never reaches the engine stops showing after its TTL.
    expect(summaries.visibleTranscriptSummaries("/repo", known, "chat-empty", t0 + 1 + summaries.PENDING_PROMPT_TTL_MS + 1)[0])
      .toBe(known[0]);
    summaries.forgetLocalChatPrompt("chat-a");
    expect(summaries.visibleTranscriptSummaries("/repo", known, "chat-empty")).toBe(known);
  });
});
