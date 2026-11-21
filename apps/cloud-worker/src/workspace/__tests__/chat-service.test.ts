import { expect, it } from "vitest";
import { ChatService } from "../chat-service";
import { SessionStore } from "../../sessions/session-store";
import { repositoryFixture } from "./repository-fixture";

const row = (id: string, role: string, text: string, extra = {}) => ({ msgId: id, kind: "text", createdAt: 100,
  payload: JSON.stringify({ id, kind: "text", role, text, createdAt: 100, ...extra }) });
async function setup() {
  const { state, root, scope } = await repositoryFixture();
  const store = await SessionStore.open(state, scope.key);
  const service = new ChatService(store, scope, async () => {});
  const chat = async (id: string, fields = {}) => store.upsert({ id, folder: root, createdAt: 100, agentId: "codex", ...fields });
  return { store, service, chat, state, scope, root };
}

it("returns bounded title seeds for at most 50 native IDs, excluding notes and fallback replies", async () => {
  const { store, service, chat } = await setup();
  await chat("first");
  await store.importMessages("first", [row("note", "user", "Local note", { localNote: {} }), row("prompt", "user", "Build the feature"),
    row("fallback", "agent", "Using another model", { modelFallback: {} }),
    row("wake", "agent", "Woke up on schedule", { wakeupNotice: { source: "loop_wakeup" } })]);
  expect(await service.handle("chats.titleSeeds", { chatIds: ["first", "missing", "first"] })).toEqual({ seeds: [
    { chatId: "first", messageId: "prompt", prompt: "Build the feature", answered: false },
  ] });
  await store.importMessages("first", [{ msgId: "tool", kind: "tool", createdAt: 101, payload: JSON.stringify({ id: "tool", kind: "tool", createdAt: 101 }) }]);
  expect(await service.handle("chats.titleSeeds", { chatIds: ["first"] })).toMatchObject({ seeds: [{ answered: true }] });
  await chat("long"); await store.importMessages("long", [row("long-prompt", "user", "A".repeat(600) + "Z".repeat(100))]);
  expect(await service.handle("chats.titleSeeds", { chatIds: ["long"] })).toMatchObject({ seeds: [{ prompt: "A".repeat(400) + "Z".repeat(100) }] });
  expect(await service.handle("chats.titleSeeds", { chatIds: [...Array(50).fill("missing"), "first"] })).toEqual({ seeds: [] });
});

it("marks a failed first turn answered even when the provider emitted no content", async () => {
  const { store, service, chat } = await setup(); await chat("failed");
  await store.enqueue("failed", { requestId: "turn", userMessageId: "prompt", prompt: [{ type: "text", text: "Go" }], startedAt: 100 });
  await store.claim("failed"); await store.finish("failed", "turn", undefined, "Provider unavailable");
  expect(await service.handle("chats.titleSeeds", { chatIds: ["failed"] })).toEqual({ seeds: [{ chatId: "failed", messageId: "prompt", prompt: "Go", answered: true }] });
});

it("bounds title seeds when a short prompt has large surrounding whitespace", async () => {
  const { store, service, chat } = await setup(); await chat("padded");
  await store.importMessages("padded", [row("prompt", "user", " \n".repeat(1_000) + "Make a change" + " \n".repeat(1_000))]);
  const result = await service.handle("chats.titleSeeds", { chatIds: ["padded"] }) as { seeds: { prompt: string }[] };
  expect(result.seeds[0]!.prompt.length).toBeLessThanOrEqual(500);
  expect(result.seeds[0]!.prompt).toBe("Make a change");
});

it("returns Local summary rows in creation order, includes archived chats, and honors folder/exclusion", async () => {
  const { store, service, chat, root, state, scope } = await setup();
  await chat("first", { title: "First", createdAt: 100, updatedAt: 900 });
  await chat("tie-a", { title: "A", createdAt: 200, archived: true });
  await chat("tie-b", { title: "B", createdAt: 200 });
  await chat("empty", { createdAt: 300 });
  for (const id of ["first", "tie-a", "tie-b"]) await store.importMessages(id, [row(`${id}-u`, "user", `Prompt ${id}`), row(`${id}-a`, "agent", "Reply")]);
  await store.importMessages("first", [row("second-user", "user", "Follow up"), { ...row("latest", "agent", "Done"), createdAt: 999 }]);
  const response = await service.handle("chats.summariesForFolder", { folder: root, excludeChatId: "tie-b" });
  expect(response).toEqual({ summaries: [
    { chatId: "tie-a", title: "A", folder: root, summary: "Prompt tie-a", summaryAt: 0, agentId: "codex", agentName: null, userMessageCount: 1, lastMessageAt: 100 },
    { chatId: "first", title: "First", folder: root, summary: "Prompt first", summaryAt: 0, agentId: "codex", agentName: null, userMessageCount: 2, lastMessageAt: 999 },
  ] });
  const reopened = await SessionStore.open(state, scope.key), next = new ChatService(reopened, scope, async () => {});
  expect(await next.handle("chats.summariesForFolder", { folder: root })).toMatchObject({ summaries: [{ chatId: "tie-b" }, { chatId: "tie-a" }, { chatId: "first" }] });
  await expect(service.handle("chats.summariesForFolder", { folder: "/other/checkout" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  await store.delete("first");
  expect(await service.handle("chats.titleSeeds", { chatIds: ["first"] })).toEqual({ seeds: [] });
});

it("switches an established chat to another agent in place and clears the old provider identity", async () => {
  const closed: string[] = [];
  const { state, scope, root } = await repositoryFixture();
  const store = await SessionStore.open(state, scope.key);
  const service = new ChatService(store, scope, async (id) => { closed.push(id); });
  await store.upsert({ id: "chat", folder: root, createdAt: 100, agentId: "claude", model: "opus" });
  await store.importMessages("chat", [row("prompt", "user", "Build the feature")]);
  await store.bind("chat", "claude", "native-claude");
  await store.update("chat", (draft) => { draft.executionId = "claude-execution"; });
  const switchAgent = (params = {}) => service.handle("chats.switchAgent",
    { chatId: "chat", fromAgentId: "claude", agentId: "codex", model: "gpt-5", effort: "high", fast: true, ...params });

  await expect(store.upsert({ id: "chat", folder: root, createdAt: 100, agentId: "codex" })).rejects.toThrow(/different agent/);
  await expect(switchAgent({ agentId: "other" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await switchAgent({ fromAgentId: "codex" })).toEqual({ ok: false });
  expect(closed).toEqual([]);

  await expect(switchAgent({ message: { msgId: "" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const marker = row("switch", "assistant", "", { kind: "tool", toolKind: "harness_switch", title: "Switched to GPT-5" });
  expect(await switchAgent({ message: { ...marker, kind: "tool" } })).toEqual({ ok: true });
  expect(closed).toEqual(["chat"]);
  expect(store.metadata("chat")?.executionId).toBeUndefined();
  expect(store.metadata("chat")).toMatchObject({ nativeSessionId: undefined, chat: { agentId: "codex", agentName: "Codex", model: "gpt-5",
    effort: "high", fast: true, sessionId: null, providerBinding: null, providerMetadata: null } });
  expect(store.snapshot("chat")?.rows.map((value) => value.msgId)).toEqual(["prompt", "switch"]);
  expect(store.snapshot("chat")?.messages.map((value) => value.id)).toEqual(["prompt", "switch"]);
  // The renderer's settings upsert and the next provider bind now match the chat's agent.
  await store.upsert({ id: "chat", folder: root, createdAt: 100, agentId: "codex", model: "gpt-5" });
  await store.bind("chat", "codex", "native-codex");
  expect(store.metadata("chat")?.chat).toMatchObject({ agentId: "codex", sessionId: "native-codex" });
  expect(await switchAgent()).toEqual({ ok: false });
});

it("refuses an agent switch while input is still queued for the old agent", async () => {
  const { store, service, chat } = await setup();
  await chat("chat", { agentId: "claude" });
  await store.update("chat", (draft) => {
    draft.inbox.push({ state: "queued" } as (typeof draft.inbox)[number]);
  });
  await expect(service.handle("chats.switchAgent", { chatId: "chat", fromAgentId: "claude", agentId: "codex" }))
    .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(store.metadata("chat")?.chat?.agentId).toBe("claude");
  await expect(service.handle("chats.switchAgent", { chatId: "missing", fromAgentId: "claude", agentId: "codex" }))
    .rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
});
