import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { getChat, upsertChat, updateChatProviderIdentity, type ChatRow } from "../db/chats";
import { startTurn, finishTurn, getTurn } from "../db/turns";
import { upsertChatMessagesBulk, windowChatMessages } from "../db/messages";
import { getConversationContext } from "../db/conversation-context";
import { providerBindingForResume } from "@zeros/protocol/identities";
import { synthesizeReplayPrompt } from "@zeros/protocol/conversation-replay";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import type { LoadSessionResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import type { WorkspaceService } from "../workspace/service";
import type { MessageRouter } from "../transport/router";

interface Internals {
  workspace: WorkspaceService;
  router: MessageRouter;
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
  sessionMessages: Map<string, AgentMessage[]>;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  conversationExecution: Map<string, string>;
  conversationCloseFlights: Map<string, Promise<void>>;
  agents: {
    endSession(agentId: string, executionId: string): Promise<void>;
    cancel(agentId: string, executionId: string): Promise<void>;
    prompt(...args: unknown[]): Promise<unknown>;
    loadSession(...args: unknown[]): Promise<unknown>;
    events: { onSessionUpdate(agentId: string, notification: SessionNotification): void };
  };
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  beginTurn(...args: unknown[]): Promise<unknown>;
}

let root: string;
let state: Internals;
let replies: EngineMessage[];
let client: TransportClient;

function chat(id: string, provider: string): ChatRow {
  return { id, folder: root, agentId: provider, agentName: provider, model: null,
    effort: "", permissionMode: "auto", lastModeId: null, prePlanModeId: null,
    fast: false, additionalDirectories: [], title: id, createdAt: 1, updatedAt: 1,
    sessionId: `native-${id}`, providerBinding: providerBindingForResume(provider, `native-${id}`),
    pinned: false, archived: false, sourceChatId: null, kind: "chat" };
}

function route(chatId: string, provider: string, execution = `execution-${chatId}`) {
  state.sessionAgent.set(execution, provider);
  state.sessionChat.set(execution, chatId);
  state.conversationExecution.set(chatId, execution);
  state.sessionLoadResponses.set(execution, { providerBinding: getChat(chatId)?.providerBinding ?? undefined });
  return execution;
}

function seed(provider: string) {
  upsertChat(chat("a", provider));
  upsertChat(chat("b", provider));
  route("a", provider);
  route("b", provider);
  for (const chatId of ["a", "b"]) {
    upsertChatMessagesBulk(chatId, ["keep", "discard"].flatMap((turn, i) => [
      { msgId: `${turn}-user`, kind: "text", createdAt: i * 2 + 1,
        payload: JSON.stringify({ id: `${turn}-user`, kind: "text", role: "user", text: `${chatId} ${turn} prompt` }) },
      { msgId: `${turn}-answer`, kind: "text", createdAt: i * 2 + 2,
        payload: JSON.stringify({ id: `${turn}-answer`, kind: "text", role: "agent", text: `${chatId} ${turn} answer` }) },
    ]));
    startTurn({ chatId, turnId: "discard-user", workspaceId: null, folder: root, agentId: provider,
      summary: "discard", startedAt: 3, preSnapshot: null });
    finishTurn(chatId, "discard-user", { endedAt: 4, status: "completed", stopReason: "end_turn", postSnapshot: null, files: [] });
  }
}

async function request(op: string, params: Record<string, unknown>) {
  const id = `${op}-${replies.length}`;
  await state.handleMessage({ type: "WORKSPACE_REQUEST", source: "browser", id, timestamp: 1, op, params }, client);
  const response = replies.find((item) => "requestId" in item && item.requestId === id);
  expect(response?.type).toBe("WORKSPACE_RESPONSE");
  return (response as Extract<EngineMessage, { type: "WORKSPACE_RESPONSE" }>).result as { resetId: string; transcriptRestored?: boolean };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zeros-turn-context-"));
  setZerosDbPathForTesting(path.join(root, "zeros.db"));
  state = new ZerosEngine({ root, port: 29917 }) as unknown as Internals;
  replies = [];
  client = { id: "desktop", kind: "local", send: (message) => replies.push(message), close: vi.fn() };
  state.router.register(client);
  vi.spyOn(state.agents, "endSession").mockResolvedValue();
  vi.spyOn(state.agents, "cancel").mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeZerosDb();
  setZerosDbPathForTesting(null);
  rmSync(root, { recursive: true, force: true });
});

describe("reset provider context", () => {
  it.each(["claude", "codex", "cursor"])("retires only the reset conversation and rejects stale identity writes for %s", async (provider) => {
    seed(provider);
    const staleChat = getChat("a")!;
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    expect(state.agents.endSession).toHaveBeenCalledExactlyOnceWith(provider, "execution-a");
    expect(state.sessionAgent.has("execution-a")).toBe(false);
    expect(state.sessionAgent.get("execution-b")).toBe(provider);
    expect(getChat("a")).toMatchObject({ sessionId: null, providerBinding: null });
    expect(getChat("b")?.providerBinding?.resumeId).toBe("native-b");
    expect(replies).toContainEqual(expect.objectContaining({ type: "DB_CHANGED", chatIds: ["a"],
      kinds: ["messages", "chats", "conversationContext"] }));
    expect(windowChatMessages("a", 20).map((row) => row.msgId)).toEqual(["keep-user", "keep-answer"]);
    expect(windowChatMessages("b", 20)).toHaveLength(4);
    await request("chats.upsert", { chat: staleChat });
    expect(getChat("a")).toMatchObject({ sessionId: null, providerBinding: null });
    // Provider output already queued when disposal happened has no authority.
    state.agents.events.onSessionUpdate(provider, { sessionId: "execution-a", update: {
      sessionUpdate: "provider_binding_update", providerBinding: staleChat.providerBinding!,
    } });
    state.agents.events.onSessionUpdate(provider, { sessionId: "execution-a", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late discarded answer" },
    } });
    expect(state.sessionLoadResponses.has("execution-a")).toBe(false);
    expect(getChat("a")?.providerBinding).toBeNull();
    expect(JSON.stringify(windowChatMessages("a", 20))).not.toContain("late discarded");
  });

  it.each(["claude", "codex", "cursor"])("rebuilds only retained history after engine restart for %s", async (provider) => {
    seed(provider);
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    closeZerosDb();
    state = new ZerosEngine({ root, port: 29917 }) as unknown as Internals;
    state.router.register(client);
    updateChatProviderIdentity("a", provider, providerBindingForResume(provider, "fresh-native"));
    const execution = route("a", provider, "fresh-execution");
    const prompt = vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    await state.handleMessage({ type: "AGENT_PROMPT", id: "continue", timestamp: 5, source: "browser", agentId: provider,
      sessionId: execution, userMessageId: "new-user", prompt: [{ type: "text", text: "Continue with retained work" }] }, client);
    expect(prompt).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(prompt.mock.calls[0][2]);
    expect(sent).toContain("a keep prompt");
    expect(sent).toContain("a keep answer");
    expect(sent).not.toContain("discard");
    expect(sent).not.toContain("b keep");
    expect(JSON.stringify(windowChatMessages("a", 20))).not.toContain("previous_conversation");
    await state.handleMessage({ type: "AGENT_PROMPT", id: "next", timestamp: 6, source: "browser", agentId: provider,
      sessionId: execution, userMessageId: "next-user", prompt: [{ type: "text", text: "Next task" }] }, client);
    expect(JSON.stringify(prompt.mock.calls[1][2])).not.toContain("previous_conversation");
  });

  it("undo invalidates a replacement execution when it restores the old history", async () => {
    seed("codex");
    const { resetId } = await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    updateChatProviderIdentity("a", "codex", providerBindingForResume("codex", "fresh-native"));
    route("a", "codex", "replacement");
    const result = await request("turns.undoReset", { resetId });
    expect(result.transcriptRestored).toBe(true);
    expect(state.agents.endSession).toHaveBeenCalledWith("codex", "replacement");
    expect(getChat("a")?.providerBinding).toBeNull();
    expect(windowChatMessages("a", 20)).toHaveLength(4);
    expect(getTurn("a", "discard-user")).not.toBeNull();
  });

  it("keeps the provider session when resetting files only", async () => {
    seed("claude");
    await request("turns.reset", { chatId: "a", turnId: "discard-user", mode: "filesOnly" });
    expect(state.agents.endSession).not.toHaveBeenCalled();
    expect(getChat("a")?.providerBinding?.resumeId).toBe("native-a");
    expect(getConversationContext("a")?.generation).toBe(0);
  });

  it("keeps a continued conversation's context when Undo can only restore files", async () => {
    seed("codex");
    const { resetId } = await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    updateChatProviderIdentity("a", "codex", providerBindingForResume("codex", "replacement"));
    route("a", "codex", "replacement");
    vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    await state.handleMessage({ type: "AGENT_PROMPT", id: "continued", timestamp: 5, source: "browser", agentId: "codex",
      sessionId: "replacement", userMessageId: "continued-user", prompt: [{ type: "text", text: "Continue" }] }, client);
    const context = getConversationContext("a");
    const result = await request("turns.undoReset", { resetId });
    expect(result.transcriptRestored).toBe(false);
    expect(state.agents.endSession).toHaveBeenCalledTimes(1);
    expect(getChat("a")?.providerBinding?.resumeId).toBe("replacement");
    expect(getConversationContext("a")).toEqual(context);
    expect(windowChatMessages("a", 20).map(row => row.msgId)).toContain("continued-user");
    expect(windowChatMessages("a", 20).map(row => row.msgId)).not.toContain("discard-user");
  });

  it.each(["cancelled", "failed"])("retries retained context after a %s first prompt", async (outcome) => {
    seed("cursor");
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    updateChatProviderIdentity("a", "cursor", providerBindingForResume("cursor", "replacement"));
    route("a", "cursor", "replacement");
    const prompt = vi.spyOn(state.agents, "prompt");
    if (outcome === "failed") prompt.mockRejectedValueOnce(new Error("provider temporarily unavailable"));
    else prompt.mockResolvedValueOnce({ stopReason: "cancelled" });
    prompt.mockResolvedValue({ stopReason: "end_turn" });
    const send = (id: string) => state.handleMessage({ type: "AGENT_PROMPT", id, timestamp: 5, source: "browser", agentId: "cursor",
      sessionId: "replacement", userMessageId: id, prompt: [{ type: "text", text: "Continue" }] }, client);
    await send("attempt");
    expect(getConversationContext("a")?.replayPending).toBe(true);
    await send("retry");
    expect(JSON.stringify(prompt.mock.calls[1][2])).toContain("a keep answer");
    expect(JSON.stringify(prompt.mock.calls[1][2])).not.toContain("a discard");
    expect(getConversationContext("a")?.replayPending).toBe(false);
  });

  it("acknowledges replay when Claude publishes its first native id during the prompt", async () => {
    seed("claude");
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    route("a", "claude", "replacement");
    state.sessionLoadResponses.set("replacement", { resumedFresh: true });
    const prompt = vi.spyOn(state.agents, "prompt").mockImplementation(async () => {
      state.agents.events.onSessionUpdate("claude", { sessionId: "replacement", update: {
        sessionUpdate: "provider_binding_update", providerBinding: providerBindingForResume("claude", "new-native"),
      } });
      return { stopReason: "end_turn" };
    });
    for (const id of ["first", "second"]) await state.handleMessage({ type: "AGENT_PROMPT", id, timestamp: 5, source: "browser", agentId: "claude",
      sessionId: "replacement", userMessageId: id, prompt: [{ type: "text", text: "Continue" }] }, client);
    expect(JSON.stringify(prompt.mock.calls[0][2])).toContain("previous_conversation");
    expect(JSON.stringify(prompt.mock.calls[1][2])).not.toContain("previous_conversation");
    expect(getConversationContext("a")?.replayPending).toBe(false);
  });

  it("cancels a prompt still preparing its snapshot before capturing the reset", async () => {
    seed("codex");
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const snapshot = new Promise<void>(resolve => { release = resolve; });
    const begin = state.beginTurn.bind(state);
    vi.spyOn(state, "beginTurn").mockImplementation(async (...args) => {
      entered();
      await snapshot;
      return begin(...args);
    });
    vi.mocked(state.agents.cancel).mockImplementation(async () => { release(); });
    const provider = vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    const turn = state.handleMessage({ type: "AGENT_PROMPT", id: "preparing", timestamp: 5, source: "browser", agentId: "codex",
      sessionId: "execution-a", userMessageId: "preparing-user", prompt: [{ type: "text", text: "Must not be dispatched" }] }, client);
    await preparing;
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    await turn;
    expect(state.agents.cancel).toHaveBeenCalledExactlyOnceWith("codex", "execution-a");
    expect(provider).not.toHaveBeenCalled();
    expect(windowChatMessages("a", 20).map(row => row.msgId)).toEqual(["keep-user", "keep-answer"]);
    expect(getTurn("a", "preparing-user")).toBeNull();
    expect(state.sessionAgent.has("execution-b")).toBe(true);
  });

  it("disposes a provider load that finishes after reset instead of reattaching discarded history", async () => {
    seed("claude");
    state.sessionAgent.delete("execution-a");
    state.sessionChat.delete("execution-a");
    state.conversationExecution.delete("a");
    let entered!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    let resolveLoad!: (response: unknown) => void;
    vi.spyOn(state.agents, "loadSession").mockImplementation(async () => {
      entered();
      return new Promise(resolve => { resolveLoad = resolve; });
    });
    const load = state.handleMessage({ type: "AGENT_LOAD_SESSION", id: "loading", timestamp: 5, source: "browser", agentId: "claude",
      chatId: "a", cwd: root }, client);
    await loading;
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    resolveLoad({ executionId: "late-execution", providerBinding: providerBindingForResume("claude", "native-a") });
    await load;
    expect(state.agents.endSession).toHaveBeenCalledWith("claude", "late-execution");
    expect(getChat("a")?.providerBinding).toBeNull();
    expect(state.sessionAgent.has("late-execution")).toBe(false);
    expect(state.conversationExecution.has("a")).toBe(false);
    expect(state.sessionAgent.has("execution-b")).toBe(true);
  });

  it("rejects an invalid reset before retiring any provider execution", async () => {
    seed("codex");
    await state.handleMessage({ type: "WORKSPACE_REQUEST", id: "invalid", timestamp: 1, source: "browser",
      op: "turns.reset", params: { chatId: "a", turnId: "missing" } }, client);
    expect(replies).toContainEqual(expect.objectContaining({ type: "WORKSPACE_ERROR", code: "VALIDATION_FAILED" }));
    expect(state.agents.endSession).not.toHaveBeenCalled();
    expect(state.agents.cancel).not.toHaveBeenCalled();
    expect(getChat("a")?.providerBinding?.resumeId).toBe("native-a");
  });

  it("replaces an older renderer's stale replay without losing the user's prompt or attachments", async () => {
    seed("codex");
    const staleReplay = synthesizeReplayPrompt(windowChatMessages("a", 20).map(row => JSON.parse(row.payload) as AgentMessage));
    await request("turns.reset", { chatId: "a", turnId: "discard-user" });
    route("a", "codex", "replacement");
    const prompt = vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    const attachment = { type: "image" as const, mimeType: "image/png", data: "fixture" };
    await state.handleMessage({ type: "AGENT_PROMPT", id: "legacy", timestamp: 5, source: "browser", agentId: "codex",
      sessionId: "replacement", userMessageId: "legacy-user", bubble: { displayText: "Continue" }, prompt: [
        { type: "text", text: staleReplay.text }, { type: "text", text: "Continue" }, attachment,
      ] }, client);
    const sent = prompt.mock.calls[0][2] as unknown[];
    expect(JSON.stringify(sent)).toContain("a keep answer");
    expect(JSON.stringify(sent)).not.toContain("discard");
    expect(sent.slice(1)).toEqual([{ type: "text", text: "Continue" }, attachment]);
    expect(JSON.stringify(windowChatMessages("a", 20))).not.toContain("previous_conversation");
  });

  it("keeps an undone interrupted turn cancelled when the retired provider finally returns", async () => {
    seed("codex");
    let entered!: () => void;
    const responding = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (response: unknown) => void;
    vi.spyOn(state.agents, "prompt").mockImplementation(async () => {
      entered();
      return new Promise(resolve => { finish = resolve; });
    });
    const turn = state.handleMessage({ type: "AGENT_PROMPT", id: "interrupted", timestamp: 5, source: "browser", agentId: "codex",
      sessionId: "execution-a", userMessageId: "interrupted-user", prompt: [{ type: "text", text: "Interrupted work" }] }, client);
    await responding;
    vi.useFakeTimers();
    const reset = request("turns.reset", { chatId: "a", turnId: "discard-user" });
    await vi.waitFor(() => expect(state.agents.cancel).toHaveBeenCalled());
    // The provider deliberately ignores cancellation. Advance its bounded
    // settlement deadline while holding the response until after Undo.
    await vi.advanceTimersByTimeAsync(3100);
    const { resetId } = await reset;
    await request("turns.undoReset", { resetId });
    expect(getTurn("a", "interrupted-user")?.status).toBe("cancelled");
    const restored = windowChatMessages("a", 20);
    finish({ stopReason: "end_turn" });
    await turn;
    expect(getTurn("a", "interrupted-user")?.status).toBe("cancelled");
    expect(windowChatMessages("a", 20)).toEqual(restored);
    expect(getConversationContext("a")).toEqual({ generation: 2, replayPending: true });
  });
});
