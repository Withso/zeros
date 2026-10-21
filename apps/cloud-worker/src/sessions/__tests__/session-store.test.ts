import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { CloudV2MessageRow } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";

const workspace = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-store-"));
  directories.push(directory);
  const store = await SessionStore.open(directory, workspace);
  await store.upsert({ id: "chat", folder: workspace, agentId: "codex", title: "Original", createdAt: 42 });
  return { directory, store };
}
const row = (id: string, role: "user" | "agent", extra: Partial<AgentTextMessage> = {}): CloudV2MessageRow => ({
  msgId: id, kind: "text", createdAt: 100,
  payload: JSON.stringify({ id, kind: "text", role, text: id, createdAt: 100, ...extra }),
});
const prompt = (id: string) => ({ requestId: id, userMessageId: `user-${id}`, prompt: [{ type: "text" as const, text: id }], startedAt: 100 });

describe("durable per-chat sessions", () => {
  it("keeps native identity, creation time and rich rows across restart and stale metadata writes", async () => {
    const { store, directory } = await setup();
    await store.bind("chat", "codex", "native-thread");
    await store.upsert({ id: "chat", folder: workspace, agentId: "codex", title: "Renamed", createdAt: 0, providerBinding: null });
    await store.importMessages("chat", [row("u", "user", { retryText: "Expanded source", autoAction: "commit" })]);
    const reopened = await SessionStore.open(directory, workspace);
    expect(reopened.snapshot("chat")).toMatchObject({ nativeSessionId: "native-thread", chat: { title: "Renamed", createdAt: 42, providerBinding: { resumeId: "native-thread" } } });
    expect(reopened.window("chat").messages).toEqual([row("u", "user", { retryText: "Expanded source", autoAction: "commit" })]);
    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
    expect(Object.keys(saved)).not.toContain("agents");
    expect(Object.keys(saved)).not.toContain("env");
    await expect(SessionStore.open(directory, "cloud://foreign/owner")).rejects.toThrow("workspace");
  });

  it("folds complete native updates and authoritative corrections through shared applyUpdate", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const { store } = await setup();
    await store.enqueue("chat", { ...prompt("first"), bubble: { displayText: "@source", retryText: "expanded" } });
    await store.claim("chat");
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "user_message_chunk", messageId: "native-user", content: { type: "text", text: "expanded" } } });
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "Working draft" } } });
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Read file", kind: "read", status: "in_progress" } });
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "agent_message_chunk", messageId: "answer", textMode: "replace", content: { type: "text", text: "Final" }, phase: "final_answer" } });
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" } });
    const rows = store.window("chat").messages;
    expect(rows.map((entry) => JSON.parse(entry.payload))).toMatchObject([
      { id: "user-first", text: "@source", retryText: "expanded", messageId: "native-user" },
      { text: "Final", messageId: "answer", phase: "final_answer" },
      { toolCallId: "tool", status: "completed" },
    ]);
    expect(rows).toHaveLength(3);
  });

  it("selects newest by ordinal, snaps to the turn opening, and pages chronologically", async () => {
    const { store } = await setup();
    await store.importMessages("chat", [row("u1", "user"), row("a1", "agent"), row("u2", "user"), row("a2", "agent"), row("steer", "user", { steeredTurnId: "u2" }), row("a3", "agent")]);
    await store.importMessages("chat", [row("a1", "agent", { text: "late correction", createdAt: 900 })]);
    expect(store.window("chat", 1).messages.map((entry) => entry.msgId)).toEqual(["u2", "a2", "steer", "a3"]);
    expect(store.window("chat", 2, 5).messages.map((entry) => entry.msgId)).toEqual(["u2", "a2"]);
    expect(store.older("chat", "u2", 1).messages.map((entry) => entry.msgId)).toEqual(["a1"]);
    expect(store.older("chat", "missing").messages).toEqual([]);
  });

  it("returns a separate opening when one turn exceeds the 1000-row budget without hiding the gap", async () => {
    const { store } = await setup();
    await store.importMessages("chat", [row("opening", "user"), ...Array.from({ length: 1200 }, (_, i) => row(`a${i}`, "agent"))]);
    const page = store.window("chat", 200);
    expect(page.messages).toHaveLength(200);
    expect(page.turnOpening?.msgId).toBe("opening");
    expect(page.messages[0].msgId).toBe("a1000");
    expect(store.older("chat", page.messages[0].msgId, 200).messages.at(-1)?.msgId).toBe("a999");
    expect(store.window("chat", 1e9).messages).toHaveLength(1000);
    expect(store.window("chat", 0).messages).toEqual([]);
    expect(store.window("chat", -1).messages).toHaveLength(1000);
  });

  it("serializes writes, deduplicates prompt deliveries and keeps completed receipts", async () => {
    const { store } = await setup();
    const delivered = await Promise.all([store.enqueue("chat", prompt("one")), store.enqueue("chat", prompt("one"))]);
    expect(delivered.map((result) => result.duplicate)).toEqual([false, true]);
    expect((await store.claim("chat"))?.requestId).toBe("one");
    expect(await store.claim("chat")).toBeUndefined();
    await store.finish("chat", "one", { stopReason: "end_turn" });
    const retry = await store.enqueue("chat", { ...prompt("one"), requestId: "new-envelope" });
    expect(retry).toMatchObject({ duplicate: true, entry: { state: "completed", response: { stopReason: "end_turn" } } });
    expect(await store.claim("chat")).toBeUndefined();
    await expect(store.enqueue("chat", { ...prompt("one"), prompt: [{ type: "text", text: "different instruction" }] })).rejects.toThrow("different");
  });

  it("retains queued messages on Stop; a new explicit send runs before the retained FIFO", async () => {
    const { store } = await setup();
    await store.enqueue("chat", prompt("a"));
    await store.claim("chat");
    await store.enqueue("chat", prompt("b"));
    await store.enqueue("chat", prompt("c"));
    await store.stop("chat");
    await store.finish("chat", "a", { stopReason: "cancelled" });
    expect(await store.claim("chat")).toBeUndefined();
    expect(store.snapshot("chat")?.inbox.filter((entry) => entry.state === "queued").map((entry) => entry.requestId)).toEqual(["b", "c"]);
    await store.enqueue("chat", prompt("d"));
    expect((await store.claim("chat"))?.requestId).toBe("d");
    await store.finish("chat", "d", { stopReason: "end_turn" });
    expect((await store.claim("chat"))?.requestId).toBe("b");
  });

  it("never replays a prompt whose native delivery was interrupted by a worker restart", async () => {
    const { store, directory } = await setup();
    await store.enqueue("chat", prompt("uncertain"));
    await store.claim("chat");
    await store.enqueue("chat", prompt("pending"));
    const reopened = await SessionStore.open(directory, workspace);
    expect(reopened.snapshot("chat")).toMatchObject({ paused: true, inbox: [{ state: "interrupted" }, { state: "queued" }] });
    expect(await reopened.claim("chat")).toBeUndefined();
    expect((await reopened.enqueue("chat", prompt("uncertain"))).duplicate).toBe(true);
    expect(await reopened.claim("chat")).toBeUndefined();
    expect(reopened.window("chat").messages[0].msgId).toBe("user-uncertain");
  });

  it("persists deletion tombstones and refuses stale upserts or late stream writes", async () => {
    const { store, directory } = await setup();
    await store.delete("chat");
    const reopened = await SessionStore.open(directory, workspace);
    expect(reopened.list()).toEqual({ chats: [], chatDeletions: ["chat"] });
    await expect(reopened.upsert({ id: "chat", folder: workspace })).rejects.toThrow("deleted");
    await expect(reopened.importMessages("chat", [row("late", "agent")])).rejects.toThrow("deleted");
  });

  it("bounds imports, skips malformed rows and preserves update order", async () => {
    const { store } = await setup();
    expect(await store.importMessages("chat", [row("a", "agent"), { ...row("bad", "agent"), payload: "{" }, row("a", "agent", { text: "replacement" })])).toBe(2);
    expect(store.window("chat").messages).toHaveLength(1);
    expect(JSON.parse(store.window("chat").messages[0].payload).text).toBe("replacement");
    await expect(store.importMessages("chat", Array(5001).fill(row("a", "agent")))).rejects.toThrow("5000");
    await expect(store.importMessages("unknown", [row("a", "agent")])).rejects.toThrow("Unknown chat");
  });
});
