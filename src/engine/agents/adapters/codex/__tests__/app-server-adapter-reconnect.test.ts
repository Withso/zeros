// Mid-turn reconnect + per-session crash signalling for the codex
// app-server adapter (docs §3.1). The `codex app-server` child can die
// under a live session; the adapter must:
//
//   - mid-turn crash → throw a RECOVERABLE transport-closed (not the
//     generic protocol-error) so the renderer auto-rebuilds + resends,
//     WITHOUT broadcasting an agent-wide exit that would flip sibling
//     Codex chats to reconnecting;
//   - idle crash → broadcast a SESSION-SCOPED exit (carries the
//     sessionId) so only that one chat blips;
//   - a send after the child died → self-heal (throw transport-closed)
//     instead of writing turn/start to a dead JSON-RPC client;
//   - a healthy turn → return normally (no false transport-closed).
//
// The real runtime needs a codex binary + auth, so `bootCodexAppServerRuntime`
// is mocked with a controllable fake handle whose runTurn + onExit the
// tests drive directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext, ContentBlock } from "../../../types";
import { AgentFailureError } from "../../../types";

// Controllable fake-runtime state shared with the (hoisted) mock factory.
const rt = vi.hoisted(() => ({
  lastOnExit: null as null | ((code: number | null, signal: unknown) => void),
  lastOnUserInputRequest: null as null | ((request: {
    questionId: string;
    params: Record<string, unknown>;
  }) => void),
  lastOnMcpElicitationRequest: null as null | ((request: {
    elicitationId: string;
    params: Record<string, unknown>;
  }) => void),
  mcpElicitationResponses: [] as Array<{
    elicitationId: string;
    response: unknown;
  }>,
  runTurnImpl: null as
    | null
    | ((params: unknown, opts: { onTurnStarted?: (id: string) => void }) => Promise<unknown>),
  /** Generic JSON-RPC requests the adapter fires (method, params) — e.g.
   *  compactContext → thread/compact/start. */
  requests: [] as Array<[string, unknown]>,
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async (opts: {
    onExit?: typeof rt.lastOnExit;
    onUserInputRequest?: typeof rt.lastOnUserInputRequest;
    onMcpElicitationRequest?: typeof rt.lastOnMcpElicitationRequest;
  }) => {
    rt.lastOnExit = opts.onExit ?? null;
    rt.lastOnUserInputRequest = opts.onUserInputRequest ?? null;
    rt.lastOnMcpElicitationRequest = opts.onMcpElicitationRequest ?? null;
    return {
      initializeResponse: {
        userAgent: "codex_cli 0.139.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
      cliVersion: "0.139.0",
      binarySource: { source: "path", path: "codex" },
      child: { pid: 1234, killed: false },
      startThread: async () => ({
        threadId: "thread-1",
        model: "gpt-5",
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        raw: {},
      }),
      resumeThread: async (p: { threadId: string }) => ({ threadId: p.threadId, raw: {} }),
      runTurn: async (
        params: unknown,
        o: { onTurnStarted?: (id: string) => void },
      ) => {
        if (!rt.runTurnImpl) throw new Error("test did not set rt.runTurnImpl");
        return rt.runTurnImpl(params, o);
      },
      interruptTurn: async () => {},
      respondToPermission: () => {},
      respondToMcpElicitation: (elicitationId: string, response: unknown) => {
        rt.mcpElicitationResponses.push({ elicitationId, response });
      },
      onNotification: () => () => {},
      request: vi.fn(async (method: string, params: unknown) => {
        rt.requests.push([method, params]);
        return {};
      }),
      dispose: async () => {},
    };
  }),
}));

// Avoid real filesystem work for the per-session dir.
vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  removeSessionDir: vi.fn(async () => {}),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted above imports).
import { CodexAppServerAdapter } from "../app-server-adapter";

const TEXT = (t: string): ContentBlock[] => [{ type: "text", text: t } as never];

function makeAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onQuestionRequest: vi.fn(),
    onAgentStderr: vi.fn(),
    onAgentExit: vi.fn(),
  };
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit,
  };
  return { adapter: new CodexAppServerAdapter(ctx), emit };
}

describe("codex mid-turn reconnect + per-session crash signalling", () => {
  beforeEach(() => {
    // Fake timers so bootSession's [1.5s/4s/9s] slash-command re-poll timers
    // don't linger past the test. Real microtasks/promises are unaffected.
    vi.useFakeTimers();
    rt.lastOnExit = null;
    rt.lastOnUserInputRequest = null;
    rt.lastOnMcpElicitationRequest = null;
    rt.mcpElicitationResponses = [];
    rt.runTurnImpl = null;
    rt.requests = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws a recoverable transport-closed when the child dies mid-turn", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    // Simulate the runtime's proc.exited path: fire onExit (child died),
    // then resolve the turn waiter "failed".
    rt.runTurnImpl = async (_params, o) => {
      o.onTurnStarted?.("turn-1");
      rt.lastOnExit?.(1, null);
      return { turnId: "turn-1", status: "failed", raw: {} };
    };

    const err = await adapter
      .prompt({ sessionId: session.sessionId, prompt: TEXT("hi") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentFailureError);
    expect((err as AgentFailureError).failure.kind).toBe("transport-closed");
    // A mid-turn crash is owned by this prompt's recoverable throw — it must
    // NOT broadcast an agent-wide exit that flips sibling Codex chats.
    expect(emit.onAgentExit).not.toHaveBeenCalled();
  });

  it("throws transport-closed when an early crash makes turn/start REJECT (not resolve failed)", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    // The child dies during the turn/start RPC: onExit fires, then runTurn
    // REJECTS (the JSON-RPC client closed) rather than resolving "failed".
    rt.runTurnImpl = async (_params, o) => {
      o.onTurnStarted?.("turn-1");
      rt.lastOnExit?.(1, null);
      throw new Error("JSON-RPC client closed: codex exited code=1");
    };

    const err = await adapter
      .prompt({ sessionId: session.sessionId, prompt: TEXT("hi") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentFailureError);
    expect((err as AgentFailureError).failure.kind).toBe("transport-closed");
  });

  it("broadcasts a session-scoped exit when the child dies while idle", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    // No turn in flight — an idle crash.
    rt.lastOnExit?.(1, "SIGKILL");

    expect(emit.onAgentExit).toHaveBeenCalledTimes(1);
    expect(emit.onAgentExit).toHaveBeenCalledWith(
      "codex",
      1,
      "SIGKILL",
      session.sessionId,
    );
  });

  it("self-heals a send that lands after the child died (no write to a dead client)", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    rt.lastOnExit?.(1, null); // idle crash → runtimeAlive=false
    rt.runTurnImpl = async () => {
      throw new Error("runTurn must not be called on a dead runtime");
    };

    const err = await adapter
      .prompt({ sessionId: session.sessionId, prompt: TEXT("hi") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentFailureError);
    expect((err as AgentFailureError).failure.kind).toBe("transport-closed");
  });

  it("prompting an UNKNOWN session is recoverable (transport-closed), not a hard error", async () => {
    const { adapter } = makeAdapter();
    // No newSession — the session was never created / already disposed
    // (e.g. superseded by a rebuild while a stale AGENT_PROMPT was in flight).
    const err = await adapter
      .prompt({ sessionId: "does-not-exist", prompt: TEXT("hi") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentFailureError);
    // Must NOT be the old plain "unknown codex session" Error (→ protocol-error
    // → hard "Agent error" toast + stranded composer). Recoverable → the
    // renderer rebuilds + resends.
    expect((err as AgentFailureError).failure.kind).toBe("transport-closed");
  });

  it("returns normally for a healthy turn (no false transport-closed, no exit)", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    rt.runTurnImpl = async (_params, o) => {
      o.onTurnStarted?.("turn-1");
      return { turnId: "turn-1", status: "completed", raw: {} };
    };

    const res = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT("hi"),
    });

    expect(res.stopReason).toBe("end_turn");
    expect(emit.onAgentExit).not.toHaveBeenCalled();
  });

  it("maps Codex request_user_input options to single-select by default", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    rt.lastOnUserInputRequest?.({
      questionId: "question-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-1",
        questions: [
          {
            id: "q0",
            header: "Validation",
            question: "How much validation do you want?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Targeted", description: "Focused checks" },
              { label: "Full suite", description: "Everything relevant" },
            ],
          },
        ],
      },
    });

    expect(emit.onQuestionRequest).toHaveBeenCalledTimes(1);
    const [, , request] = emit.onQuestionRequest.mock.calls[0];
    expect(request.sessionId).toBe(session.sessionId);
    expect(request.toolCallId).toBe("ask-1");
    expect(request.questions[0]).toMatchObject({
      id: "q0",
      prompt: "How much validation do you want?",
      multiSelect: false,
      allowOther: true,
    });
  });

  it("auto-accepts MCP tool approvals in full-access instead of Codex auto-rejecting them", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      mcpServers: [
        {
          name: "zeros-design",
          transport: "http",
          url: "http://127.0.0.1:1234/mcp",
          trusted: true,
        },
      ],
    });
    await adapter.setMode({
      sessionId: session.sessionId,
      modeId: "full-access",
    });

    rt.lastOnMcpElicitationRequest?.({
      elicitationId: "mcp-approval-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "zeros-design",
        mode: "form",
        message: "Allow the zeros-design MCP server to run update_styles?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_title: "update_styles",
          tool_params: { frame: "home.html" },
        },
      },
    });

    expect(rt.mcpElicitationResponses).toEqual([
      {
        elicitationId: "mcp-approval-1",
        response: { action: "accept", content: null, _meta: null },
      },
    ]);
    expect(emit.onPermissionRequest).not.toHaveBeenCalled();
  });

  it("surfaces Ask-mode MCP approval and maps session persistence back to Codex", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    rt.lastOnMcpElicitationRequest?.({
      elicitationId: "mcp-approval-2",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "third-party",
        mode: "form",
        message: "Allow the tool?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_title: "publish",
          tool_description: "Publish a release",
          tool_params: { tag: "v1.2.3" },
          persist: ["session", "always"],
        },
      },
    });

    const [, permissionId, request] = emit.onPermissionRequest.mock.calls[0];
    expect(permissionId).toBe("mcp-approval-2");
    expect(request.toolCall).toMatchObject({
      title: "third-party: publish",
      rawInput: {
        server: "third-party",
        tool: "publish",
        tag: "v1.2.3",
      },
    });
    expect(request.options.map((option: { optionId: string }) => option.optionId)).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ]);

    adapter.respondToPermission({
      permissionId,
      response: {
        outcome: { outcome: "selected", optionId: "acceptForSession" },
      },
    });
    expect(rt.mcpElicitationResponses).toContainEqual({
      elicitationId: "mcp-approval-2",
      response: {
        action: "accept",
        content: null,
        _meta: { persist: "session" },
      },
    });
    expect(session.sessionId).toBeTruthy();
  });

  it("fails closed for MCP write approvals in read-only mode", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    await adapter.setMode({ sessionId: session.sessionId, modeId: "read-only" });

    rt.lastOnMcpElicitationRequest?.({
      elicitationId: "mcp-approval-3",
      params: {
        serverName: "zeros-design",
        mode: "form",
        message: "Allow a write?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
      },
    });

    expect(rt.mcpElicitationResponses).toContainEqual({
      elicitationId: "mcp-approval-3",
      response: { action: "decline", content: null, _meta: null },
    });
    expect(emit.onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-accepts only trusted first-party MCP writes in Auto-Edit", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      mcpServers: [
        {
          name: "zeros-design",
          transport: "http",
          url: "http://127.0.0.1:1234/mcp",
          trusted: true,
        },
      ],
    });
    await adapter.setMode({ sessionId: session.sessionId, modeId: "auto-edit" });

    const approval = (elicitationId: string, serverName: string) => ({
      elicitationId,
      params: {
        serverName,
        mode: "form",
        message: "Allow a write?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_title: "write",
        },
      },
    });
    rt.lastOnMcpElicitationRequest?.(
      approval("mcp-trusted", "zeros-design"),
    );
    rt.lastOnMcpElicitationRequest?.(
      approval("mcp-untrusted", "third-party"),
    );

    expect(rt.mcpElicitationResponses).toContainEqual({
      elicitationId: "mcp-trusted",
      response: { action: "accept", content: null, _meta: null },
    });
    expect(emit.onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(emit.onPermissionRequest.mock.calls[0][1]).toBe("mcp-untrusted");
  });

  it("cancels non-approval and malformed MCP elicitations instead of hanging", async () => {
    const { adapter, emit } = makeAdapter();
    await adapter.newSession({ cwd: "/tmp/proj" });

    rt.lastOnMcpElicitationRequest?.({
      elicitationId: "mcp-form-1",
      params: {
        serverName: "third-party",
        mode: "form",
        message: "Enter a secret",
        requestedSchema: { type: "object", properties: {} },
        _meta: null,
      },
    });

    expect(rt.mcpElicitationResponses).toContainEqual({
      elicitationId: "mcp-form-1",
      response: { action: "cancel", content: null, _meta: null },
    });
    expect(emit.onPermissionRequest).not.toHaveBeenCalled();
    expect(emit.onAgentStderr).toHaveBeenCalledWith(
      "codex",
      expect.stringContaining("cancelled safely"),
    );
  });

  it("still surfaces a generic protocol-error when a turn fails WITHOUT a child exit", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    // Turn fails (e.g. codex `error` notification) but the child is alive.
    rt.runTurnImpl = async (_params, o) => {
      o.onTurnStarted?.("turn-1");
      return { turnId: "turn-1", status: "failed", raw: {} };
    };

    const err = await adapter
      .prompt({ sessionId: session.sessionId, prompt: TEXT("hi") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentFailureError);
    // Not a transport drop — must stay the non-recoverable protocol-error so
    // we don't mask a real turn failure as a silent retry.
    expect((err as AgentFailureError).failure.kind).toBe("protocol-error");
  });
});

describe("codex compactContext (§3.5 Task A)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.requests = [];
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("routes to thread/compact/start with the session's threadId", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    await adapter.compactContext({ sessionId: session.sessionId });

    const compact = rt.requests.filter(([m]) => m === "thread/compact/start");
    expect(compact).toHaveLength(1);
    expect(compact[0][1]).toEqual({ threadId: "thread-1" });
  });

  it("throws the disconnected failure for an unknown session (no dead-child write)", async () => {
    const { adapter } = makeAdapter();
    const err = await adapter
      .compactContext({ sessionId: "nope" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentFailureError);
  });
});
