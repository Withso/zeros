import { describe, it, expect } from "vitest";
import {
  parseBridgeMessage,
  safeParseBridgeMessage,
  KNOWN_MESSAGE_TYPES,
} from "../schemas";

const base = { id: "1", timestamp: 0 } as const;

describe("parseBridgeMessage — trust-boundary validation", () => {
  it("accepts DB_CHANGED (regression: was missing from KNOWN_MESSAGE_TYPES)", () => {
    expect(KNOWN_MESSAGE_TYPES).toContain("DB_CHANGED");
    const m = parseBridgeMessage({
      ...base,
      source: "engine",
      type: "DB_CHANGED",
      kinds: ["workspaces"],
      workspaceIds: ["workspace-a", "workspace-b"],
    });
    expect(m.type).toBe("DB_CHANGED");
    if (m.type === "DB_CHANGED") {
      expect(m.workspaceIds).toEqual(["workspace-a", "workspace-b"]);
    }
  });

  it("accepts the correlated agent-close acknowledgement", () => {
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_SESSION_CLOSED");
    expect(
      parseBridgeMessage({
        ...base,
        source: "engine",
        type: "AGENT_SESSION_CLOSED",
        requestId: "close-1",
        agentId: "codex",
        chatId: "chat-1",
      }).type,
    ).toBe("AGENT_SESSION_CLOSED");
  });

  it("rejects an unknown message type", () => {
    expect(() =>
      parseBridgeMessage({ ...base, source: "browser", type: "NOPE" }),
    ).toThrow(/Unknown bridge message type/);
  });

  it("rejects a malformed envelope", () => {
    expect(() => parseBridgeMessage({ type: "HEARTBEAT" })).toThrow();
  });

  it("rejects type-confused payloads on remote write-reaching types", () => {
    const b = { ...base, source: "browser" as const };
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: "80",
        rows: 24,
      }),
    ).toThrow(/cols/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_SET_MODE",
        agentId: "a",
        sessionId: "s",
        modeId: {},
      }),
    ).toThrow(/modeId/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "WORKSPACE_REQUEST", op: 5 }),
    ).toThrow(/op/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "PTY_WRITE", sessionId: "s", data: 5 }),
    ).toThrow(/data/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "GITHUB_TOKEN_SET", token: {} }),
    ).toThrow(/token/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "AGENT_LIST_AGENTS", force: "yes" }),
    ).toThrow(/force/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "AGENT_INIT_AGENT", agentId: {} }),
    ).toThrow(/agentId/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_AUTHENTICATE",
        agentId: "claude",
        methodId: {},
      }),
    ).toThrow(/methodId/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_LIST_SESSIONS",
        agentId: "codex",
        cursor: {},
      }),
    ).toThrow(/cursor/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_PERMISSION_RESPONSE",
        permissionId: "permission-1",
        response: { outcome: { outcome: "selected", optionId: {} } },
      }),
    ).toThrow(/response/);
    for (const request of [
      { type: "AGENT_PROMPT", executionId: "execution-1", prompt: [] },
      { type: "AGENT_STEER", executionId: "execution-1", prompt: [] },
      { type: "AGENT_CANCEL", executionId: "execution-1" },
      { type: "AGENT_COMPACT", executionId: "execution-1" },
      { type: "AGENT_CLOSE_SESSION", executionId: "execution-1" },
      {
        type: "AGENT_STOP_BACKGROUND_TASK",
        executionId: "execution-1",
        taskId: "task-1",
      },
      {
        type: "AGENT_SET_MODE",
        executionId: "execution-1",
        modeId: "default",
      },
      {
        type: "AGENT_SET_MODEL",
        executionId: "execution-1",
        model: "model-1",
      },
      {
        type: "AGENT_UPDATE_CONFIG",
        executionId: "execution-1",
        env: {},
      },
    ]) {
      expect(() => parseBridgeMessage({ ...b, ...request })).toThrow(/agentId/);
    }
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_QUESTION_RESPONSE",
        questionId: "question-1",
        response: {
          outcome: {
            outcome: "answered",
            answers: [{ questionId: "q1", selectedOptionIds: "option-1" }],
          },
        },
      }),
    ).toThrow(/response/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "a",
        sessionId: "s",
        prompt: "hi",
      }),
    ).toThrow(/prompt/);
    // WORKSPACE_APPROVAL_RESPONSE was removed with the dead host-approval
    // broker: it must now be rejected as an UNKNOWN type, not field-validated.
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "WORKSPACE_APPROVAL_RESPONSE",
        approvalId: "x",
        approved: true,
      }),
    ).toThrow(/Unknown bridge message type/);
  });

  it("bounds the pre-authenticated CONNECTED handshake", () => {
    const connected = {
      ...base,
      source: "browser" as const,
      type: "CONNECTED",
      capabilities: ["agent", "terminal"],
      protocolVersion: 1,
      authToken: "jwt-token",
    };
    expect(parseBridgeMessage(connected).type).toBe("CONNECTED");
    for (const malformed of [
      { ...connected, authToken: { nested: true } },
      { ...connected, authToken: "x".repeat(64 * 1024 + 1) },
      { ...connected, capabilities: "agent" },
      {
        ...connected,
        capabilities: Array.from({ length: 257 }, () => "agent"),
      },
      { ...connected, capabilities: ["x".repeat(257)] },
      { ...connected, protocolVersion: 1.5 },
    ]) {
      expect(() => parseBridgeMessage(malformed)).toThrow(/CONNECTED/);
    }
  });

  it("accepts well-formed write payloads", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: 80,
        rows: 24,
      }).type,
    ).toBe("PTY_RESIZE");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "a",
        sessionId: "s",
        prompt: [],
        promptId: "prompt-abc",
      }).type,
    ).toBe("AGENT_PROMPT");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "a",
        sessionId: "s",
        prompt: [],
        promptId: 12,
      }),
    ).toThrow(/promptId/);
    expect(
      parseBridgeMessage({
        ...b,
        type: "WORKSPACE_REQUEST",
        op: "git.status",
        params: {},
      }).type,
    ).toBe("WORKSPACE_REQUEST");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_STOP_BACKGROUND_TASK",
        agentId: "claude",
        sessionId: "s",
        taskId: "task-1",
      }).type,
    ).toBe("AGENT_STOP_BACKGROUND_TASK");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_PERMISSION_RESPONSE",
        permissionId: "permission-1",
        response: {
          outcome: { outcome: "selected", optionId: "allow-once" },
        },
      }).type,
    ).toBe("AGENT_PERMISSION_RESPONSE");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_QUESTION_RESPONSE",
        questionId: "question-1",
        nativeRequestId: "native-1",
        response: {
          outcome: {
            outcome: "answered",
            answers: [
              {
                questionId: "q1",
                selectedOptionIds: ["option-1"],
                freeText: "details",
              },
            ],
          },
        },
      }).type,
    ).toBe("AGENT_QUESTION_RESPONSE");
  });

  it("validates the narrow agent-memory settings protocol", () => {
    const browser = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_MEMORY_SETTINGS_READ",
        agentId: "codex",
      }).type,
    ).toBe("AGENT_MEMORY_SETTINGS_READ");
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_MEMORY_SETTINGS_UPDATE",
        agentId: "codex",
        settings: {
          localMemoriesEnabled: true,
          toolAssistedGenerationEnabled: false,
        },
      }).type,
    ).toBe("AGENT_MEMORY_SETTINGS_UPDATE");
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_MEMORY_RESET",
        agentId: "codex",
      }).type,
    ).toBe("AGENT_MEMORY_RESET");

    for (const malformed of [
      { type: "AGENT_MEMORY_SETTINGS_READ", agentId: "" },
      {
        type: "AGENT_MEMORY_SETTINGS_UPDATE",
        agentId: "codex",
        settings: {},
      },
      {
        type: "AGENT_MEMORY_SETTINGS_UPDATE",
        agentId: "codex",
        settings: { localMemoriesEnabled: "yes" },
      },
      {
        type: "AGENT_MEMORY_SETTINGS_UPDATE",
        agentId: "codex",
        settings: { localMemoriesEnabled: true, arbitrary: true },
      },
    ]) {
      expect(() => parseBridgeMessage({ ...browser, ...malformed })).toThrow();
    }
  });

  it("validates read-only provider diagnostics without exposing native RPC", () => {
    const browser = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_CONFIGURATION_PROVENANCE_READ",
        agentId: "cursor",
        cwd: "/workspace/project",
      }).type,
    ).toBe("AGENT_CONFIGURATION_PROVENANCE_READ");
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_PROVIDER_QUOTA_READ",
        agentId: "codex",
      }).type,
    ).toBe("AGENT_PROVIDER_QUOTA_READ");

    for (const malformed of [
      {
        type: "AGENT_CONFIGURATION_PROVENANCE_READ",
        agentId: "cursor",
        cwd: "",
      },
      { type: "AGENT_PROVIDER_QUOTA_READ", agentId: "" },
    ]) {
      expect(() => parseBridgeMessage({ ...browser, ...malformed })).toThrow();
    }

    // This is deliberately a pair of narrow product reads. A native operation
    // name/params escape hatch must remain an unknown bridge message.
    expect(() =>
      parseBridgeMessage({
        ...browser,
        type: "AGENT_PROVIDER_CAPABILITY_REQUEST",
        agentId: "codex",
        operation: "config/read",
        params: { includeLayers: true },
      }),
    ).toThrow();
  });

  it("validates goal and one-shot safety actions at the wire boundary", () => {
    const browser = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: {
          objective: "Ship Phase 3",
          status: "active",
          tokenBudget: null,
        },
      }).type,
    ).toBe("AGENT_GOAL_SET");
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_GOAL_CLEAR",
        agentId: "codex",
        sessionId: "session-1",
      }).type,
    ).toBe("AGENT_GOAL_CLEAR");
    expect(
      parseBridgeMessage({
        ...browser,
        type: "AGENT_RETRY_SAFETY_REVIEW",
        agentId: "codex",
        sessionId: "session-1",
        retryId: "opaque-retry-1",
      }).type,
    ).toBe("AGENT_RETRY_SAFETY_REVIEW");

    for (const malformed of [
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: {},
      },
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: { objective: "   " },
      },
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: { objective: "x".repeat(4_001) },
      },
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: { status: "running" },
      },
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: { tokenBudget: 0 },
      },
      {
        type: "AGENT_GOAL_SET",
        agentId: "codex",
        sessionId: "session-1",
        update: { status: "paused", nativeMethod: "thread/goal/set" },
      },
      {
        type: "AGENT_GOAL_CLEAR",
        agentId: "codex",
        sessionId: "",
      },
      {
        type: "AGENT_RETRY_SAFETY_REVIEW",
        agentId: "codex",
        sessionId: "session-1",
        retryId: "",
      },
    ]) {
      expect(() => parseBridgeMessage({ ...browser, ...malformed })).toThrow();
    }
  });

  it("validates session-spawn environment maps at the wire boundary", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_NEW_SESSION",
        agentId: "codex",
        workspaceId: "workspace-1",
        env: {
          OPENAI_API_KEY: "secret",
          ZEROS_THINKING_EFFORT: "high",
        },
      }).type,
    ).toBe("AGENT_NEW_SESSION");
    for (const env of [
      [],
      { GOOD: 1 },
      { "BAD=NAME": "value" },
      { GOOD: "bad\0value" },
      { GOOD: "x".repeat(512 * 1024 + 1) },
      Object.fromEntries(
        Array.from({ length: 513 }, (_, index) => [`K_${index}`, "v"]),
      ),
    ]) {
      expect(() =>
        parseBridgeMessage({
          ...b,
          type: "AGENT_NEW_SESSION",
          agentId: "codex",
          workspaceId: "workspace-1",
          env,
        }),
      ).toThrow(/env/);
    }
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_LOAD_SESSION",
        agentId: "codex",
        chatId: "chat-1",
        env: { GOOD: {} },
      }),
    ).toThrow(/env/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_GENERATE_TITLE",
        agentId: "codex",
        model: "gpt",
        systemPrompt: "title",
        prompt: "hello",
        env: { GOOD: null },
      }),
    ).toThrow(/env/);
  });

  it("lists the live boundary status and port message types", () => {
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_BOUNDARY_STATUS_CHANGED");
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_BOUNDARY_PORTS_CHANGED");
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_OPEN_BOUNDARY_PORT");
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_BOUNDARY_PORT_OPENED");
    expect(KNOWN_MESSAGE_TYPES).not.toContain("AGENT_PREFLIGHT");
    expect(KNOWN_MESSAGE_TYPES).not.toContain("AGENT_PREFLIGHTED");
  });

  it("accepts only exact opaque live-port open requests", () => {
    const b = { ...base, source: "browser" as const };
    const validPortId = "aB_9-".repeat(7).slice(0, 32);
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_OPEN_BOUNDARY_PORT",
        agentId: "codex",
        executionId: "execution-1",
        portId: validPortId,
      }).type,
    ).toBe("AGENT_OPEN_BOUNDARY_PORT");
    for (const portId of [
      "short",
      "x".repeat(31),
      "x".repeat(33),
      `${"x".repeat(31)}!`,
      { value: "x".repeat(32) },
    ]) {
      expect(() =>
        parseBridgeMessage({
          ...b,
          type: "AGENT_OPEN_BOUNDARY_PORT",
          agentId: "codex",
          executionId: "execution-1",
          portId,
        }),
      ).toThrow(/portId/);
    }
  });

  it("accepts the canonical execution route and rejects split aliases", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "codex",
        executionId: "execution-1",
        prompt: [],
      }).type,
    ).toBe("AGENT_PROMPT");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "codex",
        executionId: "execution-1",
        sessionId: "provider-thread-1",
        prompt: [],
      }),
    ).toThrow(/mismatch/);
  });

  it("accepts provider-only durable resume requests", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_LOAD_SESSION",
        agentId: "codex",
        chatId: "conversation-1",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "thread-1",
        },
      }).type,
    ).toBe("AGENT_LOAD_SESSION");
  });

  it("accepts only product-owned conversation ids for provider forks", () => {
    const b = { ...base, source: "browser" as const };
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_FORK_CONVERSATION");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_FORK_CONVERSATION",
        agentId: "codex",
        sourceChatId: "conversation-source",
        destinationChatId: "conversation-fork",
      }).type,
    ).toBe("AGENT_FORK_CONVERSATION");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_FORK_CONVERSATION",
        agentId: "codex",
        sourceChatId: "same-conversation",
        destinationChatId: "same-conversation",
      }),
    ).toThrow(/destinationChatId/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_FORK_CONVERSATION",
        agentId: "codex",
        sourceChatId: "conversation-source",
        destinationChatId: "conversation-fork",
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "raw-provider-thread",
        },
      }),
    ).toThrow(/providerBinding/);
  });

  it("accepts a conversation-only live execution probe", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_LOAD_SESSION",
        agentId: "codex",
        chatId: "conversation-1",
      }).type,
    ).toBe("AGENT_LOAD_SESSION");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_LOAD_SESSION",
        agentId: "codex",
      }),
    ).toThrow(/executionId\/chatId\/providerBinding/);
  });

  it("accepts a conversation-only close while its execution is still binding", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_CLOSE_SESSION",
        agentId: "claude",
        chatId: "conversation-1",
      }).type,
    ).toBe("AGENT_CLOSE_SESSION");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_CLOSE_SESSION",
        agentId: "claude",
      }),
    ).toThrow(/executionId\/chatId/);
  });

  it("validates live model changes against the execution route", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_SET_MODEL",
        agentId: "claude",
        executionId: "execution-1",
        model: "claude-sonnet",
      }).type,
    ).toBe("AGENT_SET_MODEL");
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_SET_MODEL",
        agentId: "claude",
        executionId: "execution-1",
        model: "",
      }),
    ).toThrow(/model/);
  });

  it("rejects an invalid background-task stop target", () => {
    const b = { ...base, source: "browser" as const };
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_STOP_BACKGROUND_TASK",
        agentId: "claude",
        sessionId: "s",
        taskId: "",
      }),
    ).toThrow(/taskId/);
  });

  it("stays permissive for engine→client / non-write types", () => {
    const b = { ...base, source: "engine" as const };
    // No payload fields — should pass (only the inbound write set is strict).
    expect(parseBridgeMessage({ ...b, type: "HEARTBEAT" }).type).toBe(
      "HEARTBEAT",
    );
    expect(
      parseBridgeMessage({ ...b, type: "AGENT_SESSION_UPDATE", sessionId: "s" })
        .type,
    ).toBe("AGENT_SESSION_UPDATE");
  });

  it("validates RESOLVE_AGENT_BINARY + accepts the PTY_CREATE ephemeral flag", () => {
    const b = { ...base, source: "browser" as const };
    // agentId is required (the handler reads it).
    expect(() =>
      parseBridgeMessage({ ...b, type: "RESOLVE_AGENT_BINARY" }),
    ).toThrow(/agentId/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "RESOLVE_AGENT_BINARY", agentId: 5 }),
    ).toThrow(/agentId/);
    expect(
      parseBridgeMessage({
        ...b,
        type: "RESOLVE_AGENT_BINARY",
        agentId: "claude",
      }).type,
    ).toBe("RESOLVE_AGENT_BINARY");
    // The new optional ephemeral flag round-trips on PTY_CREATE.
    expect(
      parseBridgeMessage({
        ...b,
        type: "PTY_CREATE",
        sessionId: "s",
        ephemeral: true,
      }).type,
    ).toBe("PTY_CREATE");
    // The engine→client reply is a known type (drift guard).
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_BINARY_RESOLVED");
  });

  it("safeParseBridgeMessage returns null on a malformed write payload", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      safeParseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: "x",
        rows: 1,
      }),
    ).toBeNull();
    expect(
      safeParseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: 80,
        rows: 24,
      }),
    ).not.toBeNull();
  });
});
