import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentGateway, NewAgentSessionOptions } from "../agents/gateway";
import type { LoadSessionResponse, NewSessionResponse } from "@zeros/protocol/agent-events";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { getChat, setChatWorkspaceResolver, upsertChat, type ChatRow } from "../db/chats";
import { upsertChatMessagesBulk, windowChatMessages } from "../db/messages";
import { finishTurn, getTurn, startTurn } from "../db/turns";
import * as gitState from "../git/state";
import type { Workspace } from "../git/types";
import { ZerosEngine } from "../index";
import type { PtyService } from "../pty/service";
import type { TerminalRegistry } from "../pty/registry";
import type { RunManager } from "../run/run-manager";
import type { SetupManager } from "../git/setup-runner";
import type { MessageRouter } from "../transport/router";
import type { TransportClient } from "../transport/types";
import type { EngineMessage } from "../types";
import type { WorkspaceService } from "../workspace/service";

interface TurnContext {
  sessionId: string;
  chatId: string;
  turnId: string;
  folder: string;
  root: string;
  workspaceId: string | null;
  startIndex: number;
  pre: string | null;
  isGit: boolean;
}

interface PromptContext {
  sessionId: string;
  agentId: string;
  chatId: string;
  turnId: string;
  promptId: string;
  startedAt: number;
  lastActivityAt: number;
  cancelledByUser?: boolean;
  terminalPublished?: boolean;
  turnRowSettled?: boolean;
  turnSnapshot?: TurnContext;
  cancelSettleTimer?: ReturnType<typeof setTimeout>;
}

interface ArchiveInternals {
  workspace: Pick<WorkspaceService, "workspaceIdForCwd"> & {
    workspaceProcessReaper(workspaceId: string, worktreePath: string): Promise<void>;
  };
  agents: AgentGateway;
  pty: Pick<PtyService, "list" | "kill" | "has" | "waitForExit">;
  terminals: TerminalRegistry;
  setup: Pick<SetupManager, "stop" | "cancelPendingStart" | "proveWorkspaceBoundaryStopped">;
  runs: Pick<RunManager, "stopAllForWorkspace" | "cancelPendingStartsForWorkspace" | "proveWorkspaceBoundariesStopped">;
  router: MessageRouter;
  sessionAgent: Map<string, string>;
  sessionWorkspace: Map<string, string>;
  sessionChat: Map<string, string>;
  conversationExecution: Map<string, string>;
  conversationBindAborts: Map<string, { token: number; controller: AbortController }>;
  workspaceProcessStarts: Map<string, Set<Promise<unknown>>>;
  promptSessions: Set<string>;
  activePromptContexts: Map<string, PromptContext>;
  activeTurnSnapshots: Map<string, TurnContext>;
  workspaceProcessStartBlock(workspaceId: string | null | undefined): string | null;
  agentSpawnOpts(message: EngineMessage, client: TransportClient, stage: string): Promise<{ cwd: string; workspaceId: string }>;
  handleAgentMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  beginConversationBind(chatId: string): number;
  enterPrompt(prompt: PromptContext): void;
  clearBusy(): void;
  workspaceIdForProcess(workspaceId: string | null, cwd: string | null): string | null;
  workspaceIdForAgentSession(sessionId: string): string | null;
}

interface GatewayOwnership {
  executionToAgent: Map<string, string>;
  executionToWorkspace: Map<string, string>;
  executionToCwd: Map<string, string>;
  executionToTerritoryContributions: Map<string, Array<{ workspaceRoot: string }>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function chat(id: string, folder: string): ChatRow {
  return {
    id, folder, agentId: "claude", agentName: "Claude", model: null,
    effort: "", permissionMode: "default", lastModeId: null, prePlanModeId: null,
    fast: false, additionalDirectories: [], title: "Untitled", createdAt: 1, updatedAt: 1,
    sessionId: "provider-thread", pinned: false, archived: false, sourceChatId: null, kind: null,
    providerBinding: { version: 1, providerId: "claude", kind: "native", resumeId: "provider-thread" },
  };
}

describe("workspace archive agent retirement", () => {
  let root: string;
  let state: ArchiveInternals;
  let owners: Workspace[];
  let archiving: Set<string>;
  let peer: TransportClient;
  let messages: EngineMessage[];

  const bind = (sessionId: string, owner: Workspace, conversationId?: string) => {
    state.sessionAgent.set(sessionId, "claude");
    state.sessionWorkspace.set(sessionId, owner.id);
    state.router.setOwner(sessionId, peer.id);
    if (conversationId) {
      upsertChat(chat(conversationId, owner.path));
      state.sessionChat.set(sessionId, conversationId);
      state.conversationExecution.set(conversationId, sessionId);
    }
  };
  const archive = (owner = owners[0]) => {
    archiving.add(owner.id);
    return state.workspace.workspaceProcessReaper(owner.id, owner.path);
  };
  const outcome = (flight: Promise<void>) => flight.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-agent-archive-")));
    closeZerosDb();
    setZerosDbPathForTesting(path.join(root, "state.sqlite"));
    state = new ZerosEngine({ root, port: 29_881 }) as unknown as ArchiveInternals;
    owners = [
      ["ws_outer", path.join(root, "outer")],
      ["ws_nested", path.join(root, "outer", "nested")],
      ["ws_sibling", path.join(root, "sibling")],
    ].map(([id, folder]): Workspace => ({
      id, path: folder, repoRoot: root, repoSlug: "fixture", branch: id, baseBranch: "main",
      status: "in-progress", createdAt: 1, archivedAt: null, stashRef: null,
      prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
    }));
    await Promise.all(owners.map((owner) => mkdir(owner.path, { recursive: true })));
    const ownerFor = (input: string | undefined): string | null => {
      if (!input) return null;
      const byId = owners.find((owner) => owner.id === input);
      if (byId) return byId.id;
      const cwd = path.resolve(input);
      return [...owners].sort((a, b) => b.path.length - a.path.length).find((owner) =>
        cwd === owner.path || cwd.startsWith(`${owner.path}${path.sep}`),
      )?.id ?? null;
    };
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockImplementation(ownerFor);
    setChatWorkspaceResolver(ownerFor);
    vi.spyOn(gitState, "getWorkspaceById").mockImplementation((id) => owners.find((owner) => owner.id === id) ?? null);
    vi.spyOn(gitState, "listWorkspaces").mockImplementation(() => owners);
    archiving = new Set();
    vi.spyOn(state, "workspaceProcessStartBlock").mockImplementation((id) =>
      id && archiving.has(id) ? "This workspace is currently in an archive operation." : null,
    );
    messages = [];
    peer = { id: "archive-client", kind: "local", send: (message) => messages.push(message), close: vi.fn() };
    state.router.register(peer);
    vi.spyOn(state.setup, "stop").mockImplementation(() => {});
    vi.spyOn(state.runs, "stopAllForWorkspace").mockImplementation(() => {});
    vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const prompt of state?.activePromptContexts.values() ?? []) {
      if (prompt.cancelSettleTimer) clearTimeout(prompt.cancelSettleTimer);
    }
    state?.clearBusy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setChatWorkspaceResolver(null);
    closeZerosDb();
    setZerosDbPathForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it("waits for an idle initialized session's successful retirement beyond three seconds", async () => {
    vi.useFakeTimers();
    bind("idle-session", owners[0], "idle-chat");
    const retirement = deferred<void>();
    vi.mocked(state.agents.endSession).mockReturnValue(retirement.promise);
    const retired = outcome(archive());
    await vi.waitFor(() => expect(state.agents.endSession).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3_100);
    retirement.resolve();

    expect(await retired).toEqual({ ok: true });
    expect(state.setup.stop).toHaveBeenCalledWith(owners[0].id);
    expect(state.sessionAgent.has("idle-session")).toBe(false);
    expect(state.sessionWorkspace.get("idle-session")).toBe(owners[0].id);
    expect(getChat("idle-chat")?.providerBinding?.resumeId).toBe("provider-thread");
  });

  it("disposes an unresponsive running prompt after persisting cancellation and preserves history", async () => {
    vi.useFakeTimers();
    bind("running-session", owners[0], "running-chat");
    bind("sibling-session", owners[2], "sibling-chat");
    const history = { id: "history-answer", kind: "text", role: "assistant", text: "Saved answer", createdAt: 1 };
    upsertChatMessagesBulk("running-chat", [{ msgId: history.id, kind: history.kind, payload: JSON.stringify(history), createdAt: 1 }]);
    startTurn({ chatId: "running-chat", turnId: "history-turn", workspaceId: owners[0].id,
      folder: owners[0].path, agentId: "claude", summary: "Saved edit", startedAt: 1, preSnapshot: "a".repeat(40) });
    finishTurn("running-chat", "history-turn", { endedAt: 2, status: "completed", stopReason: "end_turn",
      postSnapshot: "b".repeat(40), files: [{ path: "saved.txt", status: "modified", additions: 1, deletions: 0 }] });
    const previousTurn = getTurn("running-chat", "history-turn");
    startTurn({ chatId: "running-chat", turnId: "running-turn", workspaceId: owners[0].id,
      folder: owners[0].path, agentId: "claude", summary: "Current prompt", startedAt: Date.now(), preSnapshot: null });
    const snapshot: TurnContext = { sessionId: "running-session", chatId: "running-chat", turnId: "running-turn",
      workspaceId: owners[0].id, folder: owners[0].path, root: owners[0].path, startIndex: 0, pre: null, isGit: false };
    const running: PromptContext = { sessionId: "running-session", agentId: "claude", chatId: "running-chat",
      turnId: "running-turn", promptId: "running-prompt", startedAt: Date.now(), lastActivityAt: Date.now(), turnSnapshot: snapshot };
    const sibling: PromptContext = { ...running, sessionId: "sibling-session", chatId: "sibling-chat", turnSnapshot: undefined };
    for (const record of [running, sibling]) {
      state.activePromptContexts.set(record.sessionId, record);
      state.promptSessions.add(record.sessionId);
      state.enterPrompt(record);
    }
    state.activeTurnSnapshots.set(running.sessionId, snapshot);
    const cancel = vi.spyOn(state.agents, "cancel").mockResolvedValue(undefined);
    const retired = outcome(archive());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("claude", "running-session"));
    await vi.advanceTimersByTimeAsync(3_100);

    expect(await retired).toEqual({ ok: true });
    expect(state.agents.endSession).toHaveBeenCalledWith("claude", "running-session", { failClosed: true });
    expect(cancel).not.toHaveBeenCalledWith("claude", "sibling-session");
    expect(state.activePromptContexts.has("running-session")).toBe(false);
    expect(state.promptSessions.has("running-session")).toBe(false);
    expect(state.activePromptContexts.get("sibling-session")).toBe(sibling);
    expect(getTurn("running-chat", "running-turn")).toMatchObject({ status: "cancelled", stopReason: "cancelled", endedAt: expect.any(Number) });
    expect(getTurn("running-chat", "history-turn")).toEqual(previousTurn);
    expect(windowChatMessages("running-chat", 50).map((row) => row.msgId)).toContain(history.id);
    expect(getChat("running-chat")?.providerBinding?.resumeId).toBe("provider-thread");
  });

  it("preserves nested agents and sibling add-dir agents while closing only the target's processes", async () => {
    const gateway = state.agents as unknown as GatewayOwnership;
    for (const [index, owner] of owners.entries()) {
      const sessionId = `agent-${index}`;
      bind(sessionId, owner, `chat-${index}`);
      gateway.executionToAgent.set(sessionId, "claude");
      gateway.executionToWorkspace.set(sessionId, index === 1 ? owners[0].id : owner.id);
      gateway.executionToCwd.set(sessionId, owner.path);
      state.terminals.add({ sessionId: `term-${index}`, cwd: owner.path, workspaceId: index === 1 ? owners[0].id : owner.id, createdAt: 1 });
    }
    gateway.executionToTerritoryContributions.set("agent-2", [{ workspaceRoot: owners[0].path }]);
    // A chatless native execution may retain a workspace tag from before the
    // more-specific nested registration. Its actual cwd still excludes it.
    bind("chatless-nested", owners[0]);
    gateway.executionToAgent.set("chatless-nested", "claude");
    gateway.executionToWorkspace.set("chatless-nested", owners[0].id);
    gateway.executionToCwd.set("chatless-nested", owners[1].path);
    vi.spyOn(state.pty, "list").mockReturnValue(owners.map((owner, index) => ({
      sessionId: `term-${index}`, cwd: owner.path, pid: index + 1, cols: 80, rows: 24,
    })));
    vi.spyOn(state.pty, "has").mockReturnValue(true);
    vi.spyOn(state.pty, "waitForExit").mockResolvedValue(true);
    const kill = vi.spyOn(state.pty, "kill").mockImplementation(() => {});

    await archive();

    expect(state.agents.endSession).toHaveBeenCalledTimes(1);
    expect(state.agents.endSession).toHaveBeenCalledWith("claude", "agent-0", { failClosed: true });
    expect(kill.mock.calls).toEqual([["term-0"]]);
    expect(state.sessionAgent.get("agent-1")).toBe("claude");
    expect(state.sessionAgent.get("agent-2")).toBe("claude");
    expect(state.sessionAgent.get("chatless-nested")).toBe("claude");
    expect(state.terminals.get("term-1")).toBeDefined();
    expect(state.terminals.get("term-2")).toBeDefined();
    expect(vi.mocked(state.setup.stop).mock.calls).toEqual([[owners[0].id]]);
    expect(vi.mocked(state.runs.stopAllForWorkspace).mock.calls).toEqual([[owners[0].id]]);
  });

  it("uses the most-specific actual cwd owner for admission despite a stale workspace tag", () => {
    const gateway = state.agents as unknown as GatewayOwnership;
    bind("nested-session", owners[0]);
    gateway.executionToAgent.set("nested-session", "claude");
    gateway.executionToWorkspace.set("nested-session", owners[0].id);
    gateway.executionToCwd.set("nested-session", owners[1].path);

    expect(state.workspaceIdForProcess(owners[0].id, owners[1].path)).toBe(owners[1].id);
    expect(state.workspaceIdForAgentSession("nested-session")).toBe(owners[1].id);
  });

  it.each(["newSession", "loadSession"] as const)("cancels only the target's in-flight %s admission before draining", async (operation) => {
    vi.useFakeTimers();
    upsertChat(chat("starting-chat", owners[0].path));
    upsertChat(chat("other-starting-chat", owners[2].path));
    state.beginConversationBind("other-starting-chat");
    const siblingSignal = state.conversationBindAborts.get("other-starting-chat")!.controller.signal;
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({ cwd: owners[0].path, workspaceId: owners[0].id });
    vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
    const allocation = deferred<NewSessionResponse | LoadSessionResponse>();
    let signal: AbortSignal | undefined;
    const start = (options: NewAgentSessionOptions) => {
      signal = options.admissionSignal;
      signal?.addEventListener("abort", () => allocation.reject(new Error("Session admission was cancelled.")), { once: true });
      options.onExecutionCreated?.("starting-session");
      return allocation.promise;
    };
    if (operation === "newSession") {
      vi.spyOn(state.agents, "newSession").mockImplementation((_agentId, options) => start(options!) as Promise<NewSessionResponse>);
    } else {
      vi.spyOn(state.agents, "loadSession").mockImplementation((_agentId, _binding, options) => start(options!) as Promise<LoadSessionResponse>);
    }
    const starting = state.handleAgentMessage({ type: operation === "newSession" ? "AGENT_NEW_SESSION" : "AGENT_LOAD_SESSION",
      id: "starting-request", source: "browser", timestamp: 1, agentId: "claude", chatId: "starting-chat",
      workspaceId: owners[0].id, cwd: owners[0].path,
      ...(operation === "loadSession" ? { providerBinding: chat("starting-chat", owners[0].path).providerBinding! } : {}),
    } as EngineMessage, peer);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const retired = outcome(archive());
    await vi.advanceTimersByTimeAsync(5_100);
    allocation.resolve({ executionId: "starting-session", sessionId: "starting-session" });
    await starting;

    expect(await retired).toEqual({ ok: true });
    expect(signal?.aborted).toBe(true);
    expect(siblingSignal.aborted).toBe(false);
    expect(state.sessionAgent.has("starting-session")).toBe(false);
    expect(state.workspaceProcessStarts.has(owners[0].id)).toBe(false);
    expect(messages.some((message) => message.type === "AGENT_SESSION_CREATED" || message.type === "AGENT_SESSION_LOADED")).toBe(false);
    expect(getChat("starting-chat")?.providerBinding?.resumeId).toBe("provider-thread");
  });

  it("keeps archive uncommitted when session process teardown fails", async () => {
    bind("failed-session", owners[0], "failed-chat");
    vi.mocked(state.agents.endSession).mockRejectedValue(new Error("Process domain still has a writer."));
    const snapshot = vi.fn();

    await expect(archive().then(snapshot)).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    expect(snapshot).not.toHaveBeenCalled();
    expect(owners[0].archivedAt).toBeNull();
    expect(state.sessionWorkspace.get("failed-session")).toBe(owners[0].id);
    expect(getChat("failed-chat")?.providerBinding?.resumeId).toBe("provider-thread");
  });
});
