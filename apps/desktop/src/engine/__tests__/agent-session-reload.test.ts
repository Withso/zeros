import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LoadSessionResponse,
  RequestPermissionRequest,
} from "@zeros/protocol/agent-events";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import { MessageRouter } from "../transport/router";
import type { TransportClient } from "../transport/types";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";

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
    loadSession: (...args: unknown[]) => Promise<unknown>;
    prompt: (...args: unknown[]) => Promise<unknown>;
  };
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
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
  });

  it("carries the renderer promptId through re-adoption", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_889 });
    const state = internals(engine);
    const { client: owner } = testClient("owner");
    const { client: reloaded, messages } = testClient("reloaded");
    state.router.register(owner);
    state.router.register(reloaded);
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
  beforeEach(() => {
    setZerosDbPathForTesting(
      join(mkdtempSync(join(tmpdir(), "zeros-session-reload-")), "zeros.db"),
    );
  });

  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
  });

  it("refuses a remote client that names no managed workspace", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_882 });
    const state = internals(engine);
    const { client: owner } = testClient("renderer-1");
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(owner);
    state.router.register(relay);
    state.router.setOwner("session-1", owner.id);
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

  it("refuses a cold remote resume whose native thread is not bound to its chat", async () => {
    upsertChat({
      id: "chat-1",
      folder: process.cwd(),
      agentId: "codex",
      agentName: "Codex",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Bound Codex chat",
      createdAt: 1,
      updatedAt: 1,
      sessionId: "zeros-session-1",
      nativeSessionId: "codex-thread-owned",
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });

    const engine = new ZerosEngine({ root: process.cwd(), port: 29_891 });
    const state = internals(engine);
    const { client: relay, messages } = testClient("relay-1", "cloud");
    state.router.register(relay);
    vi.spyOn(state.workspace, "resolveCwd").mockReturnValue(process.cwd());
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    const loadSession = vi.spyOn(state.agents, "loadSession");

    await state.handleMessage(
      {
        type: "AGENT_LOAD_SESSION",
        id: "load-native-mismatch",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        sessionId: "zeros-session-1",
        nativeSessionId: "codex-thread-attacker",
        workspaceId: "workspace-1",
        chatId: "chat-1",
      },
      relay,
    );

    expect(loadSession).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({
        type: "AGENT_ERROR",
        code: "AGENT_PROTOCOL_ERROR",
        message: expect.stringContaining("native Codex thread"),
      }),
    ]);
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
        sessionId: "session-1",
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
