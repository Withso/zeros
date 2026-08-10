import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  LoadSessionResponse,
  RequestPermissionRequest,
} from "@zeros/protocol/agent-events";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import { MessageRouter } from "../transport/router";
import type { TransportClient } from "../transport/types";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { getChat, upsertChat } from "../db/chats";
import { AgentFailureError } from "../agents/types";

interface ActivePromptRecord {
  sessionId: string;
  agentId: string;
  chatId: string | null;
  turnId: string;
  promptId: string;
  startedAt: number;
  lastActivityAt: number;
}

interface TestEngineInternals {
  router: MessageRouter;
  agents: {
    events: {
      onSessionUpdate: (agentId: string, notification: unknown) => void;
      onAgentExit: (
        agentId: string,
        code: number | null,
        signal: string | null,
        sessionId?: string | null,
      ) => void;
    };
    loadSession: (...args: unknown[]) => Promise<unknown>;
    prompt: (...args: unknown[]) => Promise<unknown>;
    endSession: (...args: unknown[]) => Promise<unknown>;
  };
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
  conversationExecution: Map<string, string>;
  conversationBindTokens: Map<string, number>;
  sessionWorkspace: Map<string, string>;
  promptSessions: Set<string>;
  activePromptContexts: Map<string, ActivePromptRecord>;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  pendingPermissionRequests: Map<
    string,
    { agentId: string; request: RequestPermissionRequest }
  >;
  workspace: { resolveCwd: (workspaceId: string) => string };
  pty: { isWithinAllowed: (dir: string) => boolean };
  activePromptIsLive(prompt: ActivePromptRecord): boolean;
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  handleDisconnect(client: TransportClient): void;
}

function testClient(id = "renderer-1", kind: "local" | "cloud" = "local") {
  const messages: EngineMessage[] = [];
  const client: TransportClient = {
    id,
    kind,
    send: (message) => messages.push(message),
    close: vi.fn(),
  };
  return { client, messages };
}

function activePrompt(
  overrides: Partial<ActivePromptRecord> = {},
): ActivePromptRecord {
  return {
    sessionId: "session-1",
    agentId: "codex",
    chatId: "chat-1",
    turnId: "user-1",
    promptId: "prompt-reload-1",
    startedAt: 1_234,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function internals(engine: ZerosEngine): TestEngineInternals {
  return engine as unknown as TestEngineInternals;
}

describe("agent session continuity across a local renderer reload", () => {
  it("re-adopts an active prompt without asking the adapter to load it again", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_880 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "codex");
    state.activePromptContexts.set("session-1", activePrompt());
    state.sessionLoadResponses.set("session-1", {
      modes: { availableModes: [], currentModeId: "auto" },
    });
    state.pendingPermissionRequests.set("permission-1", {
      agentId: "codex",
      request: {
        sessionId: "session-1",
        toolCall: {} as RequestPermissionRequest["toolCall"],
        options: [],
      },
    });
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        chatId: "chat-1",
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          promptActive: true,
          activeTurnStartedAt: 1_234,
          promptId: "prompt-reload-1",
        }),
        expect.objectContaining({
          type: "AGENT_SESSION_UPDATE",
          notification: expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: "turn_state",
              state: "running",
            }),
          }),
        }),
        expect.objectContaining({
          type: "AGENT_PERMISSION_REQUEST",
          permissionId: "permission-1",
        }),
      ]),
    );
    expect(state.conversationBindTokens.has("chat-1")).toBe(false);
  });

  it("prefers the chat's live execution over a stale explicit reload route", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_887 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("execution-live", "codex");
    state.sessionChat.set("execution-live", "chat-live");
    state.conversationExecution.set("chat-live", "execution-live");
    state.sessionLoadResponses.set("execution-live", {});
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-stale-explicit",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        chatId: "chat-live",
        executionId: "execution-dead",
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_SESSION_LOADED",
        executionId: "execution-live",
      }),
    ]);
    expect(state.conversationExecution.get("chat-live")).toBe(
      "execution-live",
    );
  });

  it("carries the renderer promptId through re-adoption", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_889 });
    const state = internals(engine);
    const { client: owner } = testClient("owner");
    const { client: reloaded, messages } = testClient("reloaded");
    state.router.register(owner);
    state.router.register(reloaded);
    state.sessionAgent.set("session-1", "codex");
    state.activePromptContexts.set(
      "session-1",
      activePrompt({ promptId: "prompt-durable-42" }),
    );
    state.sessionLoadResponses.set("session-1", {});

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-2",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        chatId: "chat-1",
      },
      reloaded,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          promptActive: true,
          promptId: "prompt-durable-42",
        }),
      ]),
    );
  });

  it("re-adopts by Zeros conversation id without persisting the execution", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_897 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("execution-1", "codex");
    state.sessionChat.set("execution-1", "conversation-1");
    state.conversationExecution.set("conversation-1", "execution-1");
    state.sessionLoadResponses.set("execution-1", {
      providerBinding: {
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-1",
      },
    });
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-by-conversation",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        chatId: "conversation-1",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "thread-1",
        },
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          executionId: "execution-1",
          sessionId: "execution-1",
          promptActive: false,
        }),
      ]),
    );
  });

  it("refuses to re-adopt another agent's live execution", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_899 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("execution-1", "codex");
    state.sessionChat.set("execution-1", "conversation-1");
    state.conversationExecution.set("conversation-1", "execution-1");
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-with-wrong-agent",
        source: "browser",
        timestamp: 1,
        agentId: "claude",
        chatId: "conversation-1",
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        failure: expect.objectContaining({ kind: "protocol-error" }),
        message: expect.stringContaining("different agent"),
      }),
    ]);
    expect(state.sessionAgent.get("execution-1")).toBe("codex");
    expect(state.conversationExecution.get("conversation-1")).toBe(
      "execution-1",
    );
  });

  it("classifies a conversation with no live execution or binding as an expected miss", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_898 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-missing-conversation",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        chatId: "conversation-missing",
        cwd: process.cwd(),
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        failure: expect.objectContaining({ kind: "session-expired" }),
      }),
    ]);
  });

  it("never degrades a dead executionId into a provider resume locator", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_895 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-dead-execution",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        executionId: "dead-zeros-route",
        cwd: process.cwd(),
      },
      client,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        failure: expect.objectContaining({ kind: "session-expired" }),
      }),
    ]);
  });

  it("registers owner, chat, agent, and workspace before adapter resume emits", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-early-route-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    try {
      const engine = new ZerosEngine({ root: process.cwd(), port: 29_894 });
      const state = internals(engine);
      const { client: owner, messages: ownerMessages } = testClient("owner");
      const { client: observer, messages: observerMessages } = testClient(
        "observer",
        "cloud",
      );
      state.router.register(owner);
      state.router.register(observer);

      let finishLoad!: (response: LoadSessionResponse) => void;
      const loadResult = new Promise<LoadSessionResponse>((resolve) => {
        finishLoad = resolve;
      });
      vi.spyOn(state.agents, "loadSession").mockImplementation(
        async (...args: unknown[]) => {
          const opts = args[2] as {
            onExecutionCreated?: (executionId: string) => void;
          };
          expect(opts.onExecutionCreated).toBeTypeOf("function");
          opts.onExecutionCreated?.("execution-during-load");
          return loadResult;
        },
      );

      const pending = state.handleMessage(
        {
          type: "AGENT_LOAD_SESSION",
          id: "load-with-early-route",
          source: "browser",
          timestamp: 1,
          agentId: "codex",
          chatId: "chat-during-load",
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "thread-during-load",
          },
          cwd: process.cwd(),
        },
        owner,
      );

      await vi.waitFor(() => {
        expect(state.sessionAgent.get("execution-during-load")).toBe("codex");
      });
      expect(state.router.ownerOf("execution-during-load")).toBe(owner.id);
      expect(state.sessionChat.get("execution-during-load")).toBe(
        "chat-during-load",
      );
      expect(state.conversationExecution.get("chat-during-load")).toBe(
        "execution-during-load",
      );
      expect(state.sessionWorkspace.has("execution-during-load")).toBe(true);
      const workspaceId = state.sessionWorkspace.get("execution-during-load")!;
      openZerosDb()
        .prepare(
          "INSERT INTO remote_restricted_workspaces (workspace_id) VALUES (?)",
        )
        .run(workspaceId);

      state.agents.events.onSessionUpdate("codex", {
        executionId: "execution-during-load",
        sessionId: "execution-during-load",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "auto",
        },
      });
      expect(ownerMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "AGENT_SESSION_UPDATE" }),
        ]),
      );
      expect(observerMessages).toEqual([]);

      finishLoad({ executionId: "execution-during-load" });
      await pending;
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("removes a dead idle execution before a later conversation probe", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_893 });
    const state = internals(engine);
    const { client } = testClient();
    state.router.register(client);
    state.router.setOwner("dead-execution", client.id);
    state.sessionAgent.set("dead-execution", "codex");
    state.sessionChat.set("dead-execution", "chat-dead");
    state.conversationExecution.set("chat-dead", "dead-execution");
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);

    state.agents.events.onAgentExit("codex", 1, null, "dead-execution");

    expect(state.router.ownerOf("dead-execution")).toBeUndefined();
    expect(state.sessionAgent.has("dead-execution")).toBe(false);
    expect(state.sessionChat.has("dead-execution")).toBe(false);
    expect(state.conversationExecution.has("chat-dead")).toBe(false);
    await vi.waitFor(() => {
      expect(endSession).toHaveBeenCalledWith("codex", "dead-execution");
    });
  });

  it("resumes from the chat row when the renderer missed a late provider binding", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-bind-reload-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    const providerBinding = {
      version: 1 as const,
      providerId: "codex",
      kind: "native" as const,
      resumeId: "thread-learned-by-engine",
    };
    try {
      upsertChat({
        id: "db-conversation",
        folder: process.cwd(),
        agentId: "codex",
        agentName: "Codex",
        model: null,
        effort: "high",
        permissionMode: "auto",
        lastModeId: null,
        prePlanModeId: null,
        fast: false,
        additionalDirectories: [],
        title: "Persisted conversation",
        createdAt: 1,
        updatedAt: 1,
        sessionId: providerBinding.resumeId,
        providerBinding,
        providerMetadata: null,
        pinned: false,
        archived: true,
        sourceChatId: null,
        kind: "chat",
      });
      const engine = new ZerosEngine({ root: process.cwd(), port: 29_896 });
      const state = internals(engine);
      const { client, messages } = testClient();
      state.router.register(client);
      const loadSession = vi
        .spyOn(state.agents, "loadSession")
        .mockResolvedValue({
          executionId: "execution-resumed-from-db",
          providerBinding,
        });

      // This is the renderer's conversation-only probe: its React chat row
      // missed the final provider update during unmount, while SQLite has it.
      await state.handleMessage(
        {
          type: "AGENT_LOAD_SESSION",
          id: "load-binding-from-db",
          source: "browser",
          timestamp: 1,
          agentId: "codex",
          chatId: "db-conversation",
          cwd: process.cwd(),
        },
        client,
      );

      expect(loadSession).toHaveBeenCalledWith(
        "codex",
        providerBinding,
        expect.objectContaining({ cwd: process.cwd() }),
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_SESSION_LOADED",
            executionId: "execution-resumed-from-db",
          }),
        ]),
      );
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("publishes a chat invalidation when a definitive resume miss clears its binding", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-expired-bind-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    const providerBinding = {
      version: 1 as const,
      providerId: "codex",
      kind: "native" as const,
      resumeId: "expired-thread",
    };
    try {
      upsertChat({
        id: "expired-conversation",
        folder: process.cwd(),
        agentId: "codex",
        agentName: "Codex",
        model: null,
        effort: "high",
        permissionMode: "auto",
        lastModeId: null,
        prePlanModeId: null,
        fast: false,
        additionalDirectories: [],
        title: "Expired conversation",
        createdAt: 1,
        updatedAt: 1,
        sessionId: providerBinding.resumeId,
        providerBinding,
        providerMetadata: null,
        pinned: false,
        archived: true,
        sourceChatId: null,
        kind: "chat",
      });
      const engine = new ZerosEngine({ root: process.cwd(), port: 29_897 });
      const state = internals(engine);
      const { client, messages } = testClient();
      state.router.register(client);
      vi.spyOn(state.agents, "loadSession").mockRejectedValue(
        new AgentFailureError({
          kind: "session-expired",
          stage: "loadSession",
          message: "Provider thread no longer exists",
        }),
      );

      await state.handleMessage(
        {
          type: "AGENT_LOAD_SESSION",
          id: "load-expired-binding",
          source: "browser",
          timestamp: 1,
          agentId: "codex",
          chatId: "expired-conversation",
          providerBinding,
          cwd: process.cwd(),
        },
        client,
      );

      expect(getChat("expired-conversation")).toMatchObject({
        sessionId: null,
        providerBinding: null,
        providerMetadata: null,
      });
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "DB_CHANGED",
            kinds: ["chats"],
          }),
          expect.objectContaining({
            type: "AGENT_ERROR",
            failure: expect.objectContaining({ kind: "session-expired" }),
          }),
        ]),
      );
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("keeps session-to-agent identity when only the local renderer disconnects", () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_881 });
    const state = internals(engine);
    const { client } = testClient("renderer-to-reload");
    state.router.register(client);
    state.router.setOwner("session-1", client.id);
    state.sessionAgent.set("session-1", "claude");

    state.handleDisconnect(client);

    expect(state.sessionAgent.get("session-1")).toBe("claude");
  });
});

// The re-adoption fast path returns before agentSpawnOpts, which is the choke
// point that refuses an untrusted client naming no managed workspace. Nothing is
// spawned here, but ownership of a LIVE turn — its stream, its replayed
// permission cards, and the chat its transcript is written to — still moves.
describe("re-adoption keeps the remote trust boundary", () => {
  it("refuses a raw provider binding that is not attached to an accessible chat", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_888 });
    const state = internals(engine);
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(relay);
    vi.spyOn(state.workspace, "resolveCwd").mockReturnValue(process.cwd());
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    const loadSession = vi
      .spyOn(state.agents, "loadSession")
      .mockResolvedValue({ executionId: "should-not-load" });

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "raw-remote-binding",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        workspaceId: "workspace-1",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "thread-from-another-workspace",
        },
      },
      relay,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        code: "AGENT_PROTOCOL_ERROR",
      }),
    ]);
  });

  it("refuses a remote client that names no managed workspace", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_882 });
    const state = internals(engine);
    const { client: owner } = testClient("renderer-1");
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(owner);
    state.router.register(relay);
    state.router.setOwner("session-1", owner.id);
    state.sessionAgent.set("session-1", "codex");
    state.sessionChat.set("session-1", "chat-1");
    state.activePromptContexts.set("session-1", activePrompt());

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        chatId: "chat-1",
      },
      relay,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        code: "AGENT_PROTOCOL_ERROR",
      }),
    ]);
    // Ownership never moved, so the live stream still reaches the desktop.
    expect(state.router.ownerOf("session-1")).toBe(owner.id);
  });

  it("refuses a remote client naming a workspace that isn't the session's", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_890 });
    const state = internals(engine);
    const { client: owner } = testClient("renderer-1");
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(owner);
    state.router.register(relay);
    state.router.setOwner("session-1", owner.id);
    state.sessionAgent.set("session-1", "codex");
    state.sessionWorkspace.set("session-1", "workspace-1");
    // Reachable workspace, wrong one: satisfying the clamp with any workspace
    // the caller can name must not let it adopt another workspace's live turn.
    vi.spyOn(state.workspace, "resolveCwd").mockReturnValue(process.cwd());
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    state.activePromptContexts.set("session-1", activePrompt());

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        workspaceId: "workspace-2",
      },
      relay,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        code: "AGENT_PROTOCOL_ERROR",
        message: expect.stringContaining("different workspace"),
      }),
    ]);
    expect(state.router.ownerOf("session-1")).toBe(owner.id);
  });

  it("refuses a remote client trying to rebind a running turn to another chat", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_883 });
    const state = internals(engine);
    const { client: owner } = testClient("renderer-1");
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(owner);
    state.router.register(relay);
    state.router.setOwner("session-1", owner.id);
    state.sessionAgent.set("session-1", "codex");
    state.sessionChat.set("session-1", "chat-1");
    // Get PAST the workspace clamp — same managed workspace, resolvable, inside
    // the allowlist — so this pins the chat guard specifically.
    state.sessionWorkspace.set("session-1", "workspace-1");
    vi.spyOn(state.workspace, "resolveCwd").mockReturnValue(process.cwd());
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    const prompt = activePrompt();
    state.activePromptContexts.set("session-1", prompt);

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        chatId: "attacker-chat",
      },
      relay,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        code: "AGENT_PROTOCOL_ERROR",
        message: expect.stringContaining("cannot rebind a running turn"),
      }),
    ]);
    // Transcript persistence and push routing stay on the original chat.
    expect(state.sessionChat.get("session-1")).toBe("chat-1");
    expect(prompt.chatId).toBe("chat-1");
    expect(state.router.ownerOf("session-1")).toBe(owner.id);
  });

  it("still lets the local renderer re-adopt and re-state its own binding", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_884 });
    const state = internals(engine);
    const { client, messages } = testClient("renderer-2");
    state.router.register(client);
    state.sessionAgent.set("session-1", "codex");
    state.sessionChat.set("session-1", "chat-1");
    state.sessionWorkspace.set("session-1", "workspace-1");
    state.activePromptContexts.set("session-1", activePrompt());

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-1",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        chatId: "chat-1",
      },
      client,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_SESSION_LOADED",
          promptActive: true,
        }),
      ]),
    );
    expect(state.router.ownerOf("session-1")).toBe(client.id);
  });
});

// The concurrency guard refuses a second AGENT_PROMPT while a record exists, and
// that record is only retired when the adapter's prompt promise settles. A
// promise that never settles would otherwise wedge the chat for the life of the
// process — the renderer's own watchdog aborts client-side only.
describe("in-flight prompt staleness", () => {
  it("treats a silent prompt as live until the staleness bound passes", () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_885 });
    const state = internals(engine);

    expect(
      state.activePromptIsLive(
        activePrompt({ lastActivityAt: Date.now() - 40 * 60_000 }),
      ),
    ).toBe(true);
    expect(
      state.activePromptIsLive(
        activePrompt({ lastActivityAt: Date.now() - 50 * 60_000 }),
      ),
    ).toBe(false);
  });

  it("keeps a long-idle prompt live while a permission gate awaits the user", () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_886 });
    const state = internals(engine);
    state.pendingPermissionRequests.set("permission-1", {
      agentId: "codex",
      request: {
        sessionId: "session-1",
        toolCall: {} as RequestPermissionRequest["toolCall"],
        options: [],
      },
    });

    expect(
      state.activePromptIsLive(
        activePrompt({ lastActivityAt: Date.now() - 5 * 60 * 60_000 }),
      ),
    ).toBe(true);
  });

  it("refuses a concurrent send while the prompt still looks live", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_887 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.activePromptContexts.set("session-1", activePrompt());

    await state.handleMessage(
      {
        type: "AGENT_PROMPT",
        id: "prompt-2",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        executionId: "session-1",
        prompt: [{ type: "text", text: "again" }],
      } as EngineMessage,
      client,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_PROMPT_FAILED",
        error: "The agent is already responding to this chat.",
      }),
    ]);
    expect(state.activePromptContexts.has("session-1")).toBe(true);
  });

  it("keeps the execution's provider authoritative over a stale client label", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_900 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    state.sessionAgent.set("session-1", "codex");
    state.activePromptContexts.set("session-1", activePrompt());

    await state.handleMessage(
      {
        type: "AGENT_PROMPT",
        id: "prompt-with-stale-agent",
        source: "browser",
        timestamp: 1,
        agentId: "claude",
        executionId: "session-1",
        prompt: [{ type: "text", text: "again" }],
      } as EngineMessage,
      client,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_PROMPT_FAILED",
        agentId: "codex",
      }),
    ]);
    expect(state.sessionAgent.get("session-1")).toBe("codex");
  });

  it("releases a ghost record instead of refusing the chat forever", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_888 });
    const state = internals(engine);
    const { client, messages } = testClient();
    state.router.register(client);
    const ghost = activePrompt({
      lastActivityAt: Date.now() - 2 * 60 * 60_000,
    });
    state.activePromptContexts.set("session-1", ghost);
    state.promptSessions.add("session-1");
    const prompt = vi
      .spyOn(state.agents, "prompt")
      .mockRejectedValue(new Error("session is gone"));

    await state.handleMessage(
      {
        type: "AGENT_PROMPT",
        id: "prompt-2",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        prompt: [{ type: "text", text: "again" }],
      } as EngineMessage,
      client,
    );

    // The send got past the guard and ran on its own merits — it must never be
    // answered with "already responding", which no retry path recovers from.
    expect(prompt).toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_PROMPT_FAILED",
          error: "session is gone",
        }),
      ]),
    );
    expect(
      messages.filter(
        (message) =>
          (message as { error?: string }).error ===
          "The agent is already responding to this chat.",
      ),
    ).toEqual([]);
    expect(state.activePromptContexts.has("session-1")).toBe(false);
    expect(state.promptSessions.has("session-1")).toBe(false);
  });

  it("a late settle from a released ghost leaves the live turn's state alone", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_889 });
    const state = internals(engine);
    const { client } = testClient();
    state.router.register(client);
    state.activePromptContexts.set(
      "session-1",
      activePrompt({ lastActivityAt: Date.now() - 2 * 60 * 60_000 }),
    );
    // The ghost's prompt settles only after the replacement turn has taken the
    // session over — its cleanup must not strip the live turn's barrier or drop
    // its unanswered gate.
    let settleGhost = (): void => {};
    const replacement = activePrompt({ turnId: "user-2" });
    vi.spyOn(state.agents, "prompt").mockImplementation(
      () =>
        new Promise((_, reject) => {
          settleGhost = () => reject(new Error("late"));
        }),
    );

    const inFlight = state.handleMessage(
      {
        type: "AGENT_PROMPT",
        id: "prompt-2",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "session-1",
        prompt: [{ type: "text", text: "again" }],
      } as EngineMessage,
      client,
    );
    await Promise.resolve();
    state.activePromptContexts.set("session-1", replacement);
    state.promptSessions.add("session-1");
    state.pendingPermissionRequests.set("permission-live", {
      agentId: "codex",
      request: {
        sessionId: "session-1",
        toolCall: {} as RequestPermissionRequest["toolCall"],
        options: [],
      },
    });
    settleGhost();
    await inFlight;

    expect(state.activePromptContexts.get("session-1")).toBe(replacement);
    expect(state.promptSessions.has("session-1")).toBe(true);
    expect(state.pendingPermissionRequests.has("permission-live")).toBe(true);
  });
});
