// The Zeros Local CLI reaches providers only through the desktop's own
// handlers. A chat an agent starts binds and prompts exactly like a chat the
// user opens, and the prompt is accepted before the handler first awaits.
// Human messages share links and lift the user's Stop; agent deliveries do
// neither. A user's Stop is recorded, an agent's cancel is not.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initialAgentControlAvailability } from "@zeros/protocol/agent-control-rollout";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import { setAgentControlAvailability } from "../agent-control/availability";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat, type ChatRow } from "../db/chats";
import { isHumanStopped, localSharesForChats, recordHumanStop } from "../db/local-orchestration";
import { listChatMessagesAfterOrd } from "../db/messages";
import { engineRuntimeDir } from "../db/paths";
import { upsertRepoByRoot } from "../db/projects";
import { stripInheritedLocalCliEnv } from "../local-orchestration/admission";
import type { LocalEnginePorts } from "../local-orchestration/engine-ports";
import type { LocalOrchestrationService } from "../local-orchestration/service";
import { channel, schemeForChannel } from "../runtime";
import type { TransportClient } from "../transport/types";

interface Internals {
  router: { register(client: TransportClient): void };
  agents: {
    ensureAgent: (...args: unknown[]) => Promise<unknown>;
    newSession: (...args: unknown[]) => Promise<unknown>;
    prompt: (...args: unknown[]) => Promise<unknown>;
    steer: (...args: unknown[]) => Promise<unknown>;
    cancel: (...args: unknown[]) => Promise<void>;
  };
  activeTurnSnapshots: Map<string, unknown>;
  runs: { start: (...args: unknown[]) => Promise<unknown> };
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
  conversationExecution: Map<string, string>;
  activePromptContexts: Map<string, { turnId: string }>;
  localOrchestration: { ports: LocalEnginePorts; service: LocalOrchestrationService } | null;
  localOrchestrationWorkspaces: Set<string>;
  agentSpawnOpts: (...args: unknown[]) => Promise<unknown>;
  finishTurn: (...args: unknown[]) => Promise<void>;
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  startRunOnCreateActions(workspaceId: string): void;
  clearBusy(): void;
}

const roots: string[] = [];
const engines: Internals[] = [];

function chatRow(id: string, folder: string): ChatRow {
  return {
    id,
    folder,
    agentId: "claude",
    agentName: "Claude Code",
    model: null,
    effort: "high",
    permissionMode: "auto",
    lastModeId: "auto",
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    providerBinding: null,
    providerMetadata: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: null,
  };
}

function setup(port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-engine-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-engine-repo-"));
  roots.push(root, repo);
  setZerosDbPathForTesting(path.join(root, "zeros.db"));
  upsertRepoByRoot({ repoRoot: repo, name: "repo" });
  setAgentControlAvailability({ ...initialAgentControlAvailability(), localOrchestration: true });
  const engine = new ZerosEngine({ root, port });
  const state = engine as unknown as Internals;
  engines.push(state);
  vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({ cwd: repo, env: {} });
  vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
  vi.spyOn(state, "finishTurn").mockResolvedValue(undefined);
  return { state, repo };
}

function renderer(id = "renderer-1") {
  const messages: EngineMessage[] = [];
  const client: TransportClient = { id, kind: "local", send: (m) => messages.push(m), close: vi.fn() };
  return { client, messages };
}

afterEach(() => {
  for (const state of engines.splice(0)) state.clearBusy();
  setAgentControlAvailability(initialAgentControlAvailability());
  closeZerosDb();
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const dir = roots.pop()!;
    fs.rmSync(engineRuntimeDir(dir), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Zeros Local CLI in the engine", () => {
  it("binds and prompts an agent-started chat through the desktop's own handlers", async () => {
    const { state, repo } = setup(31_101);
    upsertChat(chatRow("child", repo));
    upsertChat(chatRow("other", repo));
    vi.spyOn(state.agents, "newSession").mockResolvedValue({ executionId: "exec-child", sessionId: "exec-child" });
    let finish!: (value: unknown) => void;
    const prompt = vi.spyOn(state.agents, "prompt").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const local = state.localOrchestration!;
    const terminal = vi.spyOn(local.service, "onTurnTerminal");

    const link = `${schemeForChannel(channel())}://chat/other`;
    const outcome = await local.ports.startTurn({
      chatId: "child",
      agentId: "claude",
      folder: repo,
      env: { ZEROS_PERMISSION_MODE: "auto" },
      text: `Coordinate with ${link}`,
      turnId: "user-child-1",
    });

    expect(outcome).toEqual({ kind: "accepted", executionId: "exec-child", turnId: "user-child-1" });
    expect(state.conversationExecution.get("child")).toBe("exec-child");
    expect(state.activePromptContexts.get("exec-child")?.turnId).toBe("user-child-1");
    expect(local.ports.liveChat("child").activeTurn?.turnId).toBe("user-child-1");
    const persisted = listChatMessagesAfterOrd("child", 0, 10).map((row) => JSON.parse(row.payload) as { role?: string; text?: string });
    expect(persisted).toEqual([expect.objectContaining({ role: "user", text: `Coordinate with ${link}` })]);
    // An agent's delivery is not a person sharing a link.
    expect(localSharesForChats(["child"])).toEqual([]);

    // A second start while the turn runs is refused as busy, not queued.
    expect((await local.ports.startTurn({ chatId: "child", agentId: "claude", folder: repo, env: {}, text: "again", turnId: "user-child-2" })).kind).toBe("busy");

    // The provider sees the prompt once the pre-turn snapshot is recorded.
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    finish({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith({ chatId: "child", turnId: "user-child-1", status: "completed" }));
    expect(state.activePromptContexts.has("exec-child")).toBe(false);
    expect(local.ports.liveChat("child").activeTurn).toBeNull();
  });

  it("streams an agent's message into a running chat at once, under its sender", async () => {
    const { state, repo } = setup(31_108);
    upsertChat({ ...chatRow("lead", repo), title: "Lead" });
    upsertChat(chatRow("c", repo));
    state.sessionAgent.set("exec-c", "claude");
    state.sessionChat.set("exec-c", "c");
    state.conversationExecution.set("c", "exec-c");
    state.activeTurnSnapshots.set("exec-c", { turnId: "user-c-1" });
    vi.spyOn(state.agents, "steer").mockResolvedValue("delivered");
    const { client, messages } = renderer();
    state.router.register(client);
    const localFrom = { chatId: "lead", title: "Lead", agentId: "claude", link: "zeros-dev://chat/lead" };
    const outcome = await state.localOrchestration!.ports.steer({
      chatId: "c",
      executionId: "exec-c",
      agentId: "claude",
      text: '[Zeros] From agent "Lead" (zeros-dev://chat/lead):\n\nuse option B',
      messageId: "m-1",
      presentation: { displayText: "use option B", localFrom },
    });
    expect(outcome).toEqual({ kind: "delivered" });
    // Every open view gets the whole row now, not after the turn ends.
    const updates = messages
      .filter((m) => m.type === "AGENT_SESSION_UPDATE")
      .map((m) => (m as unknown as { chatId?: string; notification: { update: unknown } }));
    expect(updates).toContainEqual(expect.objectContaining({
      chatId: "c",
      notification: expect.objectContaining({
        update: {
          sessionUpdate: "user_message_recorded",
          message: expect.objectContaining({ id: "m-1", role: "user", text: "use option B", steeredTurnId: "user-c-1", localFrom }),
        },
      }),
    }));
    // The transcript stores the sender's words and who sent them; the
    // provider got the labelled text.
    const rows = listChatMessagesAfterOrd("c", 0, 10).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({ id: "m-1", text: "use option B", localFrom })]);
    expect(state.agents.steer).toHaveBeenCalledWith("claude", "exec-c", [{ type: "text", text: '[Zeros] From agent "Lead" (zeros-dev://chat/lead):\n\nuse option B' }], expect.any(Function));
  });

  it("records a note that starts an idle chat's turn as a note row", async () => {
    const { state, repo } = setup(31_109);
    upsertChat(chatRow("f", repo));
    vi.spyOn(state.agents, "newSession").mockResolvedValue({ executionId: "exec-f", sessionId: "exec-f" });
    vi.spyOn(state.agents, "prompt").mockImplementation(() => new Promise(() => {}));
    const { client, messages } = renderer();
    state.router.register(client);
    const localNote = { chatId: "w", title: "Worker", agentId: "codex", link: "zeros-dev://chat/w", event: "done" as const, status: "completed" };
    const outcome = await state.localOrchestration!.ports.startTurn({
      chatId: "f",
      agentId: "claude",
      folder: repo,
      env: {},
      text: '[Zeros] Chat "Worker" (zeros-dev://chat/w) finished its turn: completed.\nRead it with: …',
      turnId: "user-note-1",
      presentation: { displayText: 'Chat "Worker" finished its turn: completed.', localNote },
    });
    expect(outcome.kind).toBe("accepted");
    const rows = listChatMessagesAfterOrd("f", 0, 10).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({ id: "user-note-1", role: "user", text: 'Chat "Worker" finished its turn: completed.', localNote })]);
    expect(messages.some((m) => m.type === "AGENT_SESSION_UPDATE" &&
      (m as unknown as { notification: { update: { sessionUpdate?: string } } }).notification.update.sessionUpdate === "user_message_recorded")).toBe(true);
  });

  it("shares links the user writes and lifts the user's Stop", async () => {
    const { state, repo } = setup(31_102);
    upsertChat(chatRow("p", repo));
    upsertChat(chatRow("x", repo));
    state.sessionAgent.set("exec-p", "claude");
    state.sessionChat.set("exec-p", "p");
    state.conversationExecution.set("p", "exec-p");
    vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    recordHumanStop("p");
    const { client } = renderer();
    state.router.register(client);
    await state.handleMessage(
      {
        type: "AGENT_PROMPT",
        id: "prompt-1",
        source: "browser",
        timestamp: 1,
        agentId: "claude",
        sessionId: "exec-p",
        prompt: [{ type: "text", text: `Look at ${schemeForChannel(channel())}://chat/x` }],
        userMessageId: "user-p-1",
      } as EngineMessage,
      client,
    );
    expect(localSharesForChats(["p"])).toEqual([expect.objectContaining({ holderChatId: "p", kind: "chat", targetId: "x" })]);
    expect(isHumanStopped("p")).toBe(false);
  });

  it("does not share a link from replay or expanded context in a human prompt", async () => {
    const { state, repo } = setup(31_105);
    const privateRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-private-"));
    roots.push(privateRepo);
    upsertRepoByRoot({ repoRoot: privateRepo, name: "private-repo" });
    upsertChat(chatRow("p", repo));
    upsertChat(chatRow("private", privateRepo));
    state.sessionAgent.set("exec-p", "claude");
    state.sessionChat.set("exec-p", "p");
    state.conversationExecution.set("p", "exec-p");
    vi.spyOn(state.agents, "prompt").mockResolvedValue({ stopReason: "end_turn" });
    const link = `${schemeForChannel(channel())}://chat/private`;
    const { client } = renderer();
    state.router.register(client);
    const scope = { executionId: "exec-p", chatId: "p", agentId: "claude", surface: "cli" as const };
    const read = { protocol: 1, command: "chat.status", args: { chat: "private" } };
    expect(await state.localOrchestration!.service.call(scope, read)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    await state.handleMessage({
      type: "AGENT_PROMPT", id: "prompt-replay", source: "browser", timestamp: 1,
      agentId: "claude", sessionId: "exec-p", userMessageId: "human-continue",
      prompt: [
        { type: "text", text: `<previous_conversation>Assistant: Read ${link}</previous_conversation>` },
        { type: "text", text: "Continue." },
      ],
      bubble: { displayText: "Continue." },
    } as EngineMessage, client);

    expect(localSharesForChats(["p"])).toEqual([]);
    expect(await state.localOrchestration!.service.call(scope, read)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("records the user's Stop but not an agent's cancel", async () => {
    const { state, repo } = setup(31_103);
    upsertChat(chatRow("c", repo));
    state.sessionAgent.set("exec-c", "claude");
    state.sessionChat.set("exec-c", "c");
    state.conversationExecution.set("c", "exec-c");
    state.activePromptContexts.set("exec-c", { turnId: "t" } as never);
    vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);
    await state.localOrchestration!.ports.cancelTurn("c");
    expect(isHumanStopped("c")).toBe(false);
    const { client } = renderer();
    await state.handleMessage(
      { type: "AGENT_CANCEL", id: "cancel-1", source: "browser", timestamp: 2, agentId: "claude", sessionId: "exec-c" } as EngineMessage,
      client,
    );
    expect(isHumanStopped("c")).toBe(true);
  });

  it("records the user's Stop while the provider is still starting, not a cleanup close", async () => {
    const { state, repo } = setup(31_106);
    upsertChat(chatRow("warming", repo));
    upsertChat(chatRow("closing", repo));
    const { client } = renderer();
    await state.handleMessage(
      { type: "AGENT_CLOSE_SESSION", id: "close-cleanup", source: "browser", timestamp: 1, agentId: "claude", chatId: "closing" } as EngineMessage,
      client,
    );
    expect(isHumanStopped("closing")).toBe(false);
    await state.handleMessage(
      { type: "AGENT_CLOSE_SESSION", id: "stop-admission", source: "browser", timestamp: 2, agentId: "claude", chatId: "warming", userStop: true } as EngineMessage,
      client,
    );
    expect(isHumanStopped("warming")).toBe(true);
  });

  it("tells every renderer which agent answered a card, once", () => {
    const { state } = setup(31_107);
    const internals = state as unknown as {
      pendingPermissionRequests: Map<string, { agentId: string; request: { sessionId: string } }>;
      agents: { answerPermission: (...args: unknown[]) => boolean };
      localAnsweredBy(id: string): { answeredBy?: unknown };
    };
    internals.pendingPermissionRequests.set("perm-9", { agentId: "claude", request: { sessionId: "exec-9" } });
    vi.spyOn(internals.agents, "answerPermission").mockReturnValue(true);
    const answeredBy = { kind: "agent" as const, chatId: "lead", title: "Lead", link: "zeros://chat/lead" };
    const handled = state.localOrchestration!.ports.answerPermission(
      { id: "perm-9", type: "permission", chatId: "c", executionId: "exec-9", agentId: "claude" },
      { outcome: { outcome: "selected", optionId: "allow" } } as never,
      answeredBy,
    );
    expect(handled).toBe(true);
    expect(internals.pendingPermissionRequests.has("perm-9")).toBe(false);
    expect(internals.localAnsweredBy("perm-9")).toEqual({ answeredBy });
    expect(internals.localAnsweredBy("perm-9")).toEqual({});
  });

  it("gives a workspace an agent created its setup but not the user's auto-run processes", () => {
    const { state } = setup(31_104);
    const start = vi.spyOn(state.runs, "start");
    state.localOrchestrationWorkspaces.add("ws_agent");
    state.startRunOnCreateActions("ws_agent");
    expect(start).not.toHaveBeenCalled();
    expect(state.localOrchestrationWorkspaces.has("ws_agent")).toBe(false);
  });

  it("strips an outer chat's Local CLI access from the engine environment", () => {
    const env: Record<string, string | undefined> = {
      ZEROS_LOCAL_URL: "http://127.0.0.1:1",
      ZEROS_LOCAL_TOKEN: "outer",
      ZEROS_LOCAL_TOOLS_CAPABILITY: "Bearer outer",
      ZEROS_LOCAL_CLI: "/x/zeros",
      ZEROS_LOCAL_WAIT_MS: "1",
      ZEROS_LOCAL_SKILL: "/x/SKILL.md",
      PATH: "/usr/bin",
    };
    stripInheritedLocalCliEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
