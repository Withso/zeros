// Permission requests are renderer-visible resolver handles. Once Codex drops
// a resolver (timeout, turn end, cancel, crash, or dispose), the adapter must
// emit a settlement receipt so the renderer can evict that exact queue entry.
// Otherwise a dead head hides every later live approval indefinitely.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentAdapterContext,
  ContentBlock,
  RequestPermissionResponse,
} from "../../../types";
import type {
  CodexApprovalRequest,
  CodexAppServerBootOptions,
} from "../app-server";

const rt = vi.hoisted(() => ({
  bootOptions: null as CodexAppServerBootOptions | null,
  notificationHandlers: new Map<string, Set<(params: unknown) => void>>(),
  respondCalls: [] as Array<{ permissionId: string; response: unknown }>,
  requestCalls: [] as Array<{ method: string; params: unknown }>,
  runTurnCalls: [] as unknown[],
  runTurnImpl: null as null | (() => Promise<unknown>),
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async (opts: CodexAppServerBootOptions) => {
    rt.bootOptions = opts;
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
      resumeThread: async (p: { threadId: string }) => ({
        threadId: p.threadId,
        model: "gpt-5",
        raw: {},
      }),
      runTurn: async (params: unknown) => {
        rt.runTurnCalls.push(params);
        if (!rt.runTurnImpl) {
          return { turnId: "turn-1", status: "completed", raw: {} };
        }
        return rt.runTurnImpl();
      },
      interruptTurn: async () => {},
      respondToPermission: (permissionId: string, response: unknown) => {
        rt.respondCalls.push({ permissionId, response });
      },
      respondToUserInput: () => {},
      onNotification: (method: string, handler: (params: unknown) => void) => {
        let handlers = rt.notificationHandlers.get(method);
        if (!handlers) {
          handlers = new Set();
          rt.notificationHandlers.set(method, handlers);
        }
        handlers.add(handler);
        return () => handlers?.delete(handler);
      },
      request: vi.fn(async (method: string, params: unknown) => {
        rt.requestCalls.push({ method, params });
        return {};
      }),
      dispose: async () => {},
    };
  }),
}));

vi.mock("../../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

const TEXT: ContentBlock[] = [{ type: "text", text: "go" } as never];

function makeAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onPermissionSettled: vi.fn(),
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

function raiseApproval(permissionId: string): void {
  const request: CodexApprovalRequest = {
    permissionId,
    requestId: `native-${permissionId}`,
    method: "item/commandExecution/requestApproval",
    params: { itemId: `item-${permissionId}`, command: "git status" },
  };
  rt.bootOptions?.onApprovalRequest?.(request);
}

function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } } as RequestPermissionResponse;
}

describe("codex permission settlement receipts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.bootOptions = null;
    rt.notificationHandlers.clear();
    rt.respondCalls = [];
    rt.requestCalls = [];
    rt.runTurnCalls = [];
    rt.runTurnImpl = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards a runtime timeout settlement so the renderer can advance its queue", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    raiseApproval("permission-stale");

    expect(rt.bootOptions?.onApprovalSettled).toBeTypeOf("function");
    rt.bootOptions?.onApprovalSettled?.("permission-stale");

    expect(emit.onPermissionSettled).toHaveBeenCalledWith(
      "codex",
      "permission-stale",
      session.sessionId,
    );
  });

  it("settles every parked approval when the Codex runtime exits", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    raiseApproval("permission-1");
    raiseApproval("permission-2");

    rt.bootOptions?.onExit?.(1, null);

    expect(emit.onPermissionSettled.mock.calls).toEqual([
      ["codex", "permission-1", session.sessionId],
      ["codex", "permission-2", session.sessionId],
    ]);
  });

  it("cancels and receipts parked approvals before session disposal", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    raiseApproval("permission-1");
    raiseApproval("permission-2");

    await adapter.disposeSession(session.sessionId);

    expect(rt.respondCalls).toEqual([
      { permissionId: "permission-1", response: { decision: "cancel" } },
      { permissionId: "permission-2", response: { decision: "cancel" } },
    ]);
    expect(emit.onPermissionSettled.mock.calls).toEqual([
      ["codex", "permission-1", session.sessionId],
      ["codex", "permission-2", session.sessionId],
    ]);
  });

  it("cancels and receipts parked approvals when the user stops the turn", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    raiseApproval("permission-1");

    await adapter.cancel({ sessionId: session.sessionId });

    expect(rt.respondCalls).toEqual([
      { permissionId: "permission-1", response: { decision: "cancel" } },
    ]);
    expect(emit.onPermissionSettled).toHaveBeenCalledWith(
      "codex",
      "permission-1",
      session.sessionId,
    );
  });

  it("receipts normal responses too, exactly once", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    raiseApproval("permission-1");

    adapter.respondToPermission({
      permissionId: "permission-1",
      response: cancelled(),
    });

    expect(emit.onPermissionSettled).toHaveBeenCalledTimes(1);
    expect(emit.onPermissionSettled).toHaveBeenCalledWith(
      "codex",
      "permission-1",
      session.sessionId,
    );
  });

  it("drops any resolver abandoned at turn completion before a later gate arrives", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });
    rt.runTurnImpl = async () => {
      raiseApproval("permission-stale");
      return { turnId: "turn-1", status: "completed", raw: {} };
    };

    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(rt.respondCalls).toEqual([
      { permissionId: "permission-stale", response: { decision: "cancel" } },
    ]);
    expect(emit.onPermissionSettled).toHaveBeenCalledWith(
      "codex",
      "permission-stale",
      session.sessionId,
    );
  });

  it("applies Approve for me through native auto-review without restarting the session", async () => {
    const { adapter } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj" });

    await adapter.setMode({
      sessionId: session.sessionId,
      modeId: "auto-edit",
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(rt.requestCalls).toContainEqual({
      method: "thread/settings/update",
      params: expect.objectContaining({
        threadId: "thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }),
      }),
    });
    expect(rt.runTurnCalls.at(-1)).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }),
      }),
    );

    await adapter.setMode({ sessionId: session.sessionId, modeId: "ask" });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(rt.requestCalls.at(-1)).toEqual({
      method: "thread/settings/update",
      params: expect.objectContaining({
        threadId: "thread-1",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
      }),
    });
    expect(rt.runTurnCalls.at(-1)).toEqual(
      expect.objectContaining({
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
      }),
    );
  });
});
