import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionStore } from "../../sessions/session-store";
import { TurnService } from "../turns";
import { ChatService } from "../chat-service";
import { repositoryFixture } from "./repository-fixture";

async function setup() {
  const fixture = await repositoryFixture();
  const store = await SessionStore.open(fixture.state, fixture.scope.key);
  const turns = new TurnService(store, fixture.scope);
  const chats = new ChatService(store, fixture.scope, async () => {}, turns);
  await store.upsert({ id: "chat", folder: fixture.root, agentId: "codex", createdAt: 1 });
  const edit = async (turnId: string, path: string, contents: string | Buffer) => {
    const { entry } = await store.enqueue("chat", { requestId: turnId, userMessageId: turnId,
      prompt: [{ type: "text", text: "Edit the file" }], startedAt: Date.now() });
    await store.claim("chat"); await turns.begin("chat", entry, "codex");
    await writeFile(join(fixture.root, path), contents);
    await store.fold("chat", { sessionId: "execution", update: { sessionUpdate: "tool_call",
      toolCallId: `${turnId}-edit`, title: "Edit", kind: "edit", status: "completed", rawInput: { path } } });
    await store.finish("chat", turnId, { stopReason: "end_turn" });
    await turns.finish("chat", turnId, { status: "completed", stopReason: "end_turn" });
  };
  return { ...fixture, store, turns, chats, edit };
}

it("resets the authored turn span without changing another file, staging or transcript", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "first\n");
  await f.edit("second", "second.txt", "second\n");
  await writeFile(join(f.root, "unrelated.txt"), "staged by another actor\n");
  await f.git("add", "unrelated.txt");
  const index = await f.git("diff", "--cached"), transcript = f.store.history("chat");
  const result = await f.chats.handle("turns.reset", { chatId: "chat", turnId: "first", mode: "filesOnly" });
  expect(result).toMatchObject({ truncated: 0, conflicts: [], skipped: [] });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("initial\n");
  await expect(readFile(join(f.root, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.git("diff", "--cached")).toBe(index);
  expect(f.store.history("chat")).toEqual(transcript);
});

it("keeps an overlapping later edit and reports a reset conflict", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "turn edit\n");
  await writeFile(join(f.root, "readme.txt"), "unrelated later edit\n");
  const result = await f.chats.handle("turns.reset", { chatId: "chat", turnId: "first", mode: "filesOnly" });
  expect(result).toMatchObject({ conflicts: [{ path: "readme.txt", result: "conflict" }], applied: [] });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("unrelated later edit\n");
});

it("can undo a file reset after the session store restarts", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "turn edit\n");
  const reset = await f.chats.handle("turns.reset", { chatId: "chat", turnId: "first", mode: "filesOnly" }) as { resetId: string };
  await f.store.flush();
  const reopened = await SessionStore.open(f.state, f.scope.key);
  const chats = new ChatService(reopened, f.scope, async () => {}, new TurnService(reopened, f.scope));
  const result = await chats.handle("turns.undoReset", { resetId: reset.resetId });
  expect(result).toMatchObject({ restored: [{ path: "readme.txt", result: "restored" }], transcriptRestored: false });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("turn edit\n");
});

it("replaces the full transcript and provider context, then restores it on an unused undo after restart", async () => {
  const f = await setup();
  const chats = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  await f.edit("first", "readme.txt", "first\n");
  await f.edit("second", "second.txt", "second\n");
  await f.store.bind("chat", "codex", "native-before-cut");
  const rows = f.store.history("chat"), records = f.store.turnRecords("chat");
  const reset = await chats.handle("turns.reset", { chatId: "chat", turnId: "first" }) as { resetId: string };
  expect(f.store.history("chat")).toEqual([]);
  expect(f.store.turnRecords("chat")).toEqual([]);
  expect(f.store.metadata("chat")).toMatchObject({ chat: { sessionId: null, providerBinding: null } });
  expect(f.store.metadata("chat")?.nativeSessionId).toBeUndefined();
  expect(f.store.receipt("chat", "first")?.state).toBe("completed");
  await f.store.importMessages("chat", [...rows]);
  expect(f.store.history("chat")).toEqual([]);
  await f.store.flush();
  const reopened = await SessionStore.open(f.state, f.scope.key);
  const restored = await new ChatService(reopened, f.scope, async () => {}, new TurnService(reopened, f.scope), { historyReplacement: () => true })
    .handle("turns.undoReset", { resetId: reset.resetId });
  expect(restored).toMatchObject({ transcriptRestored: true, messagesRestored: rows.length });
  expect(reopened.history("chat")).toEqual(rows);
  expect(reopened.turnRecords("chat")).toEqual(records);
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("first\n");
});

it("keeps a continued transcript on undo while restoring files", async () => {
  const f = await setup(), chats = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  await f.edit("first", "readme.txt", "first\n");
  const reset = await chats.handle("turns.reset", { chatId: "chat", turnId: "first" }) as { resetId: string };
  await f.store.enqueue("chat", { requestId: "after", userMessageId: "after", prompt: [{ type: "text", text: "Continue" }], startedAt: Date.now() });
  await f.store.claim("chat");
  const continued = f.store.history("chat");
  expect(await chats.handle("turns.undoReset", { resetId: reset.resetId })).toMatchObject({ transcriptRestored: false });
  expect(f.store.history("chat")).toEqual(continued);
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("first\n");
});

it("refuses a transcript mutation on an older control plane before cancelling or editing files", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "first\n");
  let cancelled = false;
  const chats = new ChatService(f.store, f.scope, async () => { cancelled = true; }, f.turns);
  const rows = f.store.history("chat");
  await expect(chats.handle("turns.reset", { chatId: "chat", turnId: "first" })).rejects.toMatchObject({ code: "CLOUD_V2_UNSUPPORTED" });
  expect(cancelled).toBe(false);
  expect(f.store.history("chat")).toEqual(rows);
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("first\n");
});

it("truncates from a message without changing files, and refuses stale transcript imports", async () => {
  const f = await setup(), chats = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  await f.edit("first", "readme.txt", "first\n");
  await f.edit("second", "second.txt", "second\n");
  const rows = f.store.history("chat");
  const second = rows.findIndex(row => row.msgId === "second");
  expect(await chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "second" })).toEqual({ removed: rows.length - second });
  expect(f.store.history("chat")).toEqual(rows.slice(0, second));
  await f.store.importMessages("chat", [...rows]);
  expect(f.store.history("chat")).toEqual(rows.slice(0, second));
  expect(await readFile(join(f.root, "second.txt"), "utf8")).toBe("second\n");
});

it("skips a missing legacy snapshot object without treating its authored file as absent", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "turn edit\n");
  const turn = f.store.turnRecord("chat", "first")!;
  await f.store.saveTurn({ ...turn, preSnapshot: "a".repeat(40) });
  expect(await f.chats.handle("turns.reset", { chatId: "chat", turnId: "first", mode: "filesOnly" }))
    .toMatchObject({ applied: [], skipped: [{ path: "readme.txt", result: "skipped", reason: "no snapshot available" }] });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("turn edit\n");
});

it("returns replacement state only to a negotiated worker history reader", async () => {
  const f = await setup();
  await f.edit("first", "readme.txt", "first\n");
  await f.store.stopOutbox("chat", "3"); await f.store.truncateMessages("chat", "first");
  const modern = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  expect(await modern.handle("messages.window", { chatId: "chat" })).toEqual({ messages: [], historyState: { revision: 1, beforeEpoch: "3" } });
  expect(await f.chats.handle("messages.window", { chatId: "chat" })).toEqual({ messages: [] });
  expect(await modern.handle("messages.windowOlder", { chatId: "chat", beforeMsgId: "first" })).toMatchObject({ historyState: { revision: 1, beforeEpoch: "3" } });
});

it("returns the durable cut even if private-ref cleanup is unavailable", async () => {
  const f = await setup(), chats = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  await f.edit("first", "readme.txt", "first\n");
  vi.spyOn(f.turns, "prune").mockRejectedValueOnce(new Error("Git cleanup unavailable"));
  expect(await chats.handle("messages.truncateFrom", { chatId: "chat", fromMsgId: "first" })).toMatchObject({ removed: expect.any(Number) });
  expect(f.store.history("chat")).toEqual([]);
});

it("keeps five undo records and their referenced turn trees through pruning and Git GC", async () => {
  const f = await setup(), chats = new ChatService(f.store, f.scope, async () => {}, f.turns, { historyReplacement: () => true });
  const resets: string[] = [];
  for (let index = 0; index < 6; index++) {
    await f.edit(`turn-${index}`, "readme.txt", `turn ${index}\n`);
    const reset = await chats.handle("turns.reset", { chatId: "chat", turnId: `turn-${index}` }) as { resetId: string };
    resets.push(reset.resetId);
  }
  expect(f.store.resetRecord(resets[0]!)).toBeUndefined();
  expect(f.store.snapshot("chat")?.resets).toHaveLength(5);
  await f.git("gc", "--prune=now");
  const retained = f.store.snapshot("chat")!.resets!;
  for (const reset of retained) for (const tree of [reset.snapshot, reset.postSnapshot, ...reset.turns.flatMap(turn => [turn.preSnapshot, turn.postSnapshot])])
    if (tree) expect((await f.git("cat-file", "-t", tree)).trim()).toBe("tree");
  expect(await chats.handle("turns.undoReset", { resetId: resets[5] })).toMatchObject({ transcriptRestored: true });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("turn 5\n");
});
