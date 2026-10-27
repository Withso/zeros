import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnInfo } from "@zeros/protocol/turns";
import type { ToolKind } from "@zeros/protocol/agent-events";
import { SessionStore } from "../../sessions/session-store";
import { HistoryMirror } from "../../sessions/history-mirror";
import { FakeRelay } from "../../__tests__/worker-fixtures";
import { TurnService } from "../turns";
import { ChatService } from "../chat-service";
import { GitService } from "../git";
import { repositoryFixture } from "./repository-fixture";

async function setup() {
  const fixture = await repositoryFixture();
  const store = await SessionStore.open(fixture.state, fixture.scope.key);
  const turns = new TurnService(store, fixture.scope);
  const chat = new ChatService(store, fixture.scope, async () => {}, turns);
  const gitService = new GitService(fixture.scope, { historyDiff: params => turns.historyDiff(params) });
  const begin = async (chatId = "chat", turnId = "opening", agentId = "codex", startedAt = 100) => {
    if (!store.metadata(chatId)) await store.upsert({ id: chatId, folder: fixture.root, agentId, createdAt: 1 });
    const { entry } = await store.enqueue(chatId, { requestId: turnId, userMessageId: turnId, prompt: [{ type: "text", text: "Change files" }], startedAt });
    await store.claim(chatId);
    await turns.begin(chatId, entry, agentId);
  };
  const tool = async (chatId: string, id: string, toolKind: ToolKind, rawInput: unknown, status: "completed" | "failed" = "completed") =>
    store.fold(chatId, { sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: id, title: "Edit", kind: toolKind, status, rawInput } });
  const finish = async (chatId = "chat", turnId = "opening") => {
    await store.finish(chatId, turnId, { stopReason: "end_turn" });
    return turns.finish(chatId, turnId, { status: "completed", stopReason: "end_turn" });
  };
  return { ...fixture, store, turns, chat, gitService, begin, tool, finish };
}

describe("cloud recorded turn changes", () => {
  it.each(["claude", "codex", "cursor"])("records %s native paths against real disk changes and preserves staging", async agentId => {
    const { root, git, store, chat, begin, tool, finish, gitService } = await setup();
    await writeFile(join(root, "readme.txt"), "already staged\n");
    await git("add", "readme.txt");
    const staged = await git("diff", "--cached");
    await begin("chat", "opening", agentId);
    await writeFile(join(root, "readme.txt"), "changed in turn\nsecond line\n");
    const input = agentId === "claude" ? { file_path: join(root, "readme.txt") }
      : agentId === "codex" ? { changes: [{ path: "readme.txt" }] } : { path: "readme.txt" };
    await tool("chat", "edit", "edit", input);
    await finish();
    const record = store.turnRecord("chat", "opening")!;
    expect(record.files).toEqual([{ path: "readme.txt", oldPath: undefined, status: "modified", additions: 2, deletions: 1 }]);
    expect(await git("diff", "--cached")).toBe(staged);
    expect(await git("branch", "--show-current")).toBe("workspace/fixture");
    await writeFile(join(root, "readme.txt"), "later unrelated work\n");
    const result = await chat.handle("turns.diff", { chatId: "chat", turnId: "opening", path: "readme.txt" }) as { patch: string };
    expect(result.patch).toContain("-already staged");
    expect(result.patch).toContain("+changed in turn");
    expect(result.patch).not.toContain("later unrelated");
    const identity = { chatId: "chat", turnId: "opening" };
    expect(await gitService.handle("git.diff", { history: { kind: "turn-range", from: identity, to: identity }, rawPatch: true })).toMatchObject({ patch: result.patch });
  });

  it("excludes denied, no-op, read-only and other-chat edits while retaining partial shell mutations", async () => {
    const { root, git, store, begin, tool, finish } = await setup();
    for (const name of ["denied.txt", "noop.txt", "read.txt", "removed.txt"]) await writeFile(join(root, name), "before\n");
    await git("add", "."); await git("commit", "-m", "fixtures");
    await begin();
    await begin("other", "other-turn");
    await writeFile(join(root, "denied.txt"), "other actor\n");
    await writeFile(join(root, "read.txt"), "other actor\n");
    await writeFile(join(root, "other.txt"), "other chat\n");
    await rm(join(root, "removed.txt"));
    await tool("chat", "denied", "edit", { path: "denied.txt" }, "failed");
    await tool("chat", "noop", "edit", { path: "noop.txt" });
    await tool("chat", "read", "read", { path: "read.txt" });
    await tool("chat", "shell", "execute", { command: "rm removed.txt && false" }, "failed");
    await tool("other", "edit", "edit", { path: "other.txt" });
    await finish(); await finish("other", "other-turn");
    expect(store.turnRecord("chat", "opening")!.files).toMatchObject([{ path: "removed.txt", additions: 0, deletions: 1 }]);
    expect(store.turnRecord("other", "other-turn")!.files.map(file => file.path)).toEqual(["other.txt"]);
  });

  it("mirrors summary metadata with the opening prompt and restores exact diffs after restart", async () => {
    const { root, state, scope, store, turns, begin, tool, finish } = await setup();
    const relay = new FakeRelay(); relay.connected = true;
    const mirror = new HistoryMirror(store, relay); mirror.connect();
    await begin();
    await writeFile(join(root, "literal ü [1].txt"), "new\n");
    await tool("chat", "write", "edit", { path: "literal ü [1].txt" });
    const prompt = await finish();
    await mirror.flush();
    expect(prompt!.turnSummary!.files[0].path).toBe("literal ü [1].txt");
    expect(prompt!.turnSummary).not.toHaveProperty("folder");
    expect(prompt!.turnSummary).not.toHaveProperty("preSnapshot");
    expect(relay.frames.some(frame => frame.t === "history" && frame.messages?.rows.some(row => row.msgId === "opening" && row.payload.includes('"turnSummary"')))).toBe(true);
    await mirror.dispose(); await store.flush();
    const reopened = await SessionStore.open(state, scope.key);
    const next = new TurnService(reopened, scope);
    expect(await next.handle("turns.list", {})).toEqual(await turns.handle("turns.list", {}));
    expect(await next.handle("turns.diff", { chatId: "chat", turnId: "opening" })).toEqual(await turns.handle("turns.diff", { chatId: "chat", turnId: "opening" }));
    await reopened.delete("chat");
    expect(await next.handle("turns.list", {})).toEqual({ turns: [] });
  });

  it("keeps binary/deleted rows and excludes ignored files and outside paths", async () => {
    const { root, git, store, begin, tool, finish, chat } = await setup();
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await git("add", "."); await git("commit", "-m", "ignore fixture");
    await begin();
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "ignored.txt"), "private\n");
    await rm(join(root, "readme.txt"));
    await tool("chat", "edit", "edit", { changes: [{ path: "binary.dat" }, { path: "ignored.txt" }, { path: "../outside.txt" }] });
    await tool("chat", "delete", "delete", { path: "readme.txt" });
    await finish();
    expect(store.turnRecord("chat", "opening")!.files.map(file => [file.path, file.additions, file.deletions])).toEqual([
      ["binary.dat", 0, 0], ["readme.txt", 0, 1],
    ]);
    await expect(chat.handle("turns.diff", { chatId: "chat", turnId: "opening", path: "../outside.txt" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(chat.handle("turns.list", { workspaceId: "another-workspace" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("private\n");
  });

  it("retains worker-owned summaries through stale imports and drops unrecorded claims", async () => {
    const { root, state, scope, store, begin, tool, finish } = await setup();
    await begin();
    const stale = structuredClone(store.history("chat").find(row => row.msgId === "opening")!);
    await writeFile(join(root, "readme.txt"), "recorded edit\n");
    await tool("chat", "edit", "edit", { path: "readme.txt" });
    const prompt = await finish();
    const turn = store.turnRecord("chat", "opening");
    await store.importMessages("chat", [stale, { ...stale, msgId: "unrecorded", payload: JSON.stringify({ ...prompt, id: "unrecorded" }) }]);
    const reopened = await SessionStore.open(state, scope.key);
    const messages = reopened.snapshot("chat")!.messages;
    expect(messages.find(message => message.id === "opening")).toMatchObject({ turnSummary: JSON.parse(JSON.stringify(prompt!.turnSummary)) });
    expect(messages.find(message => message.id === "unrecorded")).not.toHaveProperty("turnSummary");
    expect(reopened.turnRecord("chat", "opening")).toEqual(turn);
  });

  it("releases only the deleted chat's snapshot refs", async () => {
    const { root, git, chat, begin, tool, finish } = await setup();
    await begin(); await writeFile(join(root, "readme.txt"), "first\n");
    await tool("chat", "edit", "edit", { path: "readme.txt" }); await finish();
    await begin("other", "other-turn"); await writeFile(join(root, "other.txt"), "other\n");
    await tool("other", "edit", "edit", { path: "other.txt" }); await finish("other", "other-turn");
    const refs = () => git("for-each-ref", "--format=%(refname)", "refs/zeros/turns/");
    expect((await refs()).split("\n")).toHaveLength(4);
    await chat.handle("chats.delete", { id: "chat" });
    expect((await refs()).split("\n")).toHaveLength(2);
    expect(await chat.handle("turns.diff", { chatId: "other", turnId: "other-turn" })).toMatchObject({ patch: expect.stringContaining("+other") });
    await chat.handle("chats.delete", { id: "other" });
    expect(await refs()).toBe("");
  });

  it.each(["single", "aggregate"])("returns file metadata when a %s historical patch exceeds the byte limit", async shape => {
    const { root, begin, tool, finish, turns } = await setup();
    const count = shape === "single" ? 1 : 2;
    for (let index = 0; index < count; index++) {
      const turnId = `turn-${index}`, path = `generated-${index}.txt`;
      await begin("chat", turnId, "codex", index + 1);
      await writeFile(join(root, path), ("x".repeat(1024) + "\n").repeat((shape === "single" ? 7 : 4) * 1024));
      await tool("chat", `write-${index}`, "edit", { path }); await finish("chat", turnId);
    }
    const result = await turns.historyDiff({ history: { kind: "turns" }, rawPatch: true, summaryLimit: 100 }) as {
      hunks: unknown[]; summary?: boolean; files: { path: string }[];
    };
    expect(result.summary).toBe(true);
    expect(result.hunks).toEqual([]);
    expect(result.files.map(file => file.path)).toEqual(Array.from({ length: count }, (_, index) => `generated-${index}.txt`));
  });

  it("combines turn ranges per authored path and keeps explicit selections pinned", async () => {
    const { root, store, begin, tool, finish, turns } = await setup();
    await begin(); await writeFile(join(root, "readme.txt"), "first\n"); await tool("chat", "edit1", "edit", { path: "readme.txt" }); await finish();
    await begin("chat", "second", "codex", 200); await writeFile(join(root, "readme.txt"), "second\n"); await tool("chat", "edit2", "edit", { path: "readme.txt" }); await finish("chat", "second");
    const from = { chatId: "chat", turnId: "opening" }, to = { chatId: "chat", turnId: "second" };
    const range = await turns.historyDiff({ history: { kind: "turn-range", from, to }, rawPatch: true }) as { patch: string };
    expect(range.patch).toContain("-initial"); expect(range.patch).toContain("+second");
    expect(await turns.historyDiff({ history: { kind: "turn-range", from, to: from }, rawPatch: true })).toMatchObject({ patch: expect.stringContaining("+first") });
    await store.update("chat", draft => { draft.turns!.find(turn => turn.turnId === "opening")!.preSnapshot = null; });
    await expect(turns.historyDiff({ history: { kind: "turns" } })).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
  });

  it("pages tied timestamps without skipping or duplicating turn identities", async () => {
    const { store, begin, turns, finish } = await setup();
    await begin(); await finish();
    const original = store.turnRecord("chat", "opening")!;
    await store.update("chat", draft => { draft.turns = ["a", "b", "c"].map(turnId => ({ ...original, turnId,
      files: [{ path: "readme.txt", status: "modified", additions: 1, deletions: 1 }] })); });
    const { turns: first } = await turns.handle("turns.list", { limit: 2 }) as { turns: TurnInfo[] };
    const { chatId, turnId, startedAt } = first.at(-1)!;
    const { turns: second } = await turns.handle("turns.list", { limit: 2, offset: 2, before: first[0].startedAt, after: { chatId, turnId, startedAt } }) as { turns: TurnInfo[] };
    expect([...first, ...second].map(turn => turn.turnId)).toEqual(["c", "b", "a"]);
  });
});
