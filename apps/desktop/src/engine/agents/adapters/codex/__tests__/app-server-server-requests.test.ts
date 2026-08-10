import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StdioAgentProcess } from "../../shared/stdio-process";
import { MAX_PENDING_MCP_ELICITATIONS } from "../../shared/mcp-elicitation";

const harness = vi.hoisted(() => ({
  proc: null as StdioAgentProcess | null,
}));

vi.mock("../../shared/stdio-process", () => ({
  spawnStdioAgent: vi.fn(() => {
    if (!harness.proc) throw new Error("test process was not installed");
    return harness.proc;
  }),
}));

vi.mock("../binary-resolver", () => ({
  resolveCodexBinary: vi.fn(async () => ({
    path: "/tmp/codex",
    source: "bundled",
  })),
}));

vi.mock("../../shared/login-shell-path", () => ({
  buildSpawnEnvWithLoginPath: vi.fn(async (env?: Record<string, string>) => ({
    ...env,
  })),
}));

import {
  bootCodexAppServerRuntime,
  redactCodexRpcLine,
  type CodexUserInputRequest,
} from "../app-server";

interface RpcFrame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function createFakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;

  const outbound: RpcFrame[] = [];
  let stdinBuffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    stdinBuffer += chunk;
    let newline = stdinBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdinBuffer.slice(0, newline);
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (line.trim()) {
        const frame = JSON.parse(line) as RpcFrame;
        outbound.push(frame);
        if (frame.method === "initialize" && frame.id != null) {
          send({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              userAgent: "codex_cli 0.146.0",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "linux",
            },
          });
        }
      }
      newline = stdinBuffer.indexOf("\n");
    }
  });

  let resolveExit!: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveExit = resolve;
  });
  const proc: StdioAgentProcess = {
    child: child as never,
    processGroupId: child.pid,
    exited,
    stop: vi.fn(async () => {
      if (child.killed) return;
      child.killed = true;
      child.exitCode = 0;
      resolveExit({ code: 0, signal: null });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }),
  };

  function send(frame: Record<string, unknown>): void {
    child.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  function crash(code = 1): void {
    if (child.killed) return;
    child.killed = true;
    child.exitCode = code;
    resolveExit({ code, signal: null });
    child.emit("exit", code, null);
    child.emit("close", code, null);
  }

  async function waitFor(
    predicate: (frame: RpcFrame) => boolean,
  ): Promise<RpcFrame> {
    for (let i = 0; i < 100; i++) {
      const found = outbound.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`outbound frame not observed: ${JSON.stringify(outbound)}`);
  }

  return { proc, outbound, send, crash, waitFor };
}

describe("codex app-server initiated requests", () => {
  beforeEach(() => {
    harness.proc = null;
  });

  it("advertises the extended MCP form capability during initialize", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
    });

    const initialize = await fake.waitFor(
      (frame) => frame.method === "initialize",
    );
    expect(initialize.params).toMatchObject({
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        requestAttestation: false,
      },
    });

    await runtime.dispose();
  });

  it("answers currentTime/read instead of rejecting a native Codex request", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
    });

    fake.send({
      jsonrpc: "2.0",
      id: 41,
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    });

    const response = await fake.waitFor((frame) => frame.id === 41);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      currentTimeAt: expect.any(Number),
    });
    expect(
      (response.result as { currentTimeAt: number }).currentTimeAt,
    ).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    await runtime.dispose();
  });

  it("wires optional auth, attestation, and dynamic-tool providers into the runtime", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const onDynamicToolCall = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "tool complete" }],
    }));
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onDynamicToolCall,
      refreshChatgptAuthTokens: async () => ({
        accessToken: "fresh-token",
        chatgptAccountId: "account-1",
        chatgptPlanType: "plus",
      }),
      generateAttestation: async () => ({ token: "opaque-attestation" }),
    });

    const initialize = await fake.waitFor(
      (frame) => frame.method === "initialize",
    );
    expect(initialize.params).toMatchObject({
      capabilities: { requestAttestation: true },
    });

    fake.send({
      jsonrpc: "2.0",
      id: 51,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "workspace",
        tool: "inspect",
        arguments: {},
      },
    });
    expect((await fake.waitFor((frame) => frame.id === 51)).result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "tool complete" }],
    });

    fake.send({
      jsonrpc: "2.0",
      id: 52,
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "account-1" },
    });
    expect((await fake.waitFor((frame) => frame.id === 52)).result).toEqual({
      accessToken: "fresh-token",
      chatgptAccountId: "account-1",
      chatgptPlanType: "plus",
    });

    fake.send({
      jsonrpc: "2.0",
      id: 53,
      method: "attestation/generate",
      params: {},
    });
    expect((await fake.waitFor((frame) => frame.id === 53)).result).toEqual({
      token: "opaque-attestation",
    });
    expect(onDynamicToolCall).toHaveBeenCalledOnce();

    await runtime.dispose();
  });

  it("round-trips a deprecated exec approval instead of returning method-not-found", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const approvals: Array<{
      permissionId: string;
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onApprovalRequest: (request) => approvals.push(request),
    });

    fake.send({
      jsonrpc: "2.0",
      id: 42,
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        callId: "call-1",
        approvalId: null,
        command: ["git", "status"],
        cwd: "/tmp/project",
        reason: null,
        parsedCmd: [],
      },
    });

    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({
      method: "execCommandApproval",
      params: { callId: "call-1", command: ["git", "status"] },
    });
    runtime.respondToPermission(approvals[0].permissionId, {
      decision: "approved",
    });
    const response = await fake.waitFor((frame) => frame.id === 42);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ decision: "approved" });

    await runtime.dispose();
  });

  it("round-trips MCP form elicitation through the blocking question channel", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const requests: CodexUserInputRequest[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => requests.push(request),
    });

    fake.send({
      jsonrpc: "2.0",
      id: "mcp-7",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "billing",
        mode: "form",
        message: "Where should the invoice go?",
        requestedSchema: {
          type: "object",
          properties: {
            email: { type: "string", title: "Email", format: "email" },
          },
          required: ["email"],
        },
        _meta: null,
      },
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "mcpServer/elicitation/request",
      rpcRequestId: "mcp-7",
      params: { mode: "form", serverName: "billing" },
    });

    runtime.respondToUserInput(requests[0].questionId, {
      action: "accept",
      content: { email: "person@example.com" },
      _meta: null,
    });
    const response = await fake.waitFor((frame) => frame.id === "mcp-7");
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      action: "accept",
      content: { email: "person@example.com" },
      _meta: null,
    });

    await runtime.dispose();
  });

  it("bounds concurrent MCP elicitations instead of flooding the question UI", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const requests: CodexUserInputRequest[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => requests.push(request),
    });

    for (let index = 0; index <= MAX_PENDING_MCP_ELICITATIONS; index++) {
      fake.send({
        jsonrpc: "2.0",
        id: `mcp-flood-${index}`,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "untrusted",
          mode: "form",
          message: "More input",
          requestedSchema: { type: "object", properties: {} },
          _meta: null,
        },
      });
    }

    await vi.waitFor(() =>
      expect(requests).toHaveLength(MAX_PENDING_MCP_ELICITATIONS),
    );
    const overflow = await fake.waitFor(
      (frame) => frame.id === `mcp-flood-${MAX_PENDING_MCP_ELICITATIONS}`,
    );
    expect(overflow.result).toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });

    await runtime.dispose();
  });

  it("honors Codex's shorter auto-resolution deadline for native questions", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const requests: CodexUserInputRequest[] = [];
    const now = Date.now();
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => requests.push(request),
    });

    fake.send({
      jsonrpc: "2.0",
      id: "question-deadline",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-item",
        questions: [],
        autoResolutionMs: 60_000,
      },
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].expiresAt).toBeGreaterThanOrEqual(now + 59_000);
    expect(requests[0].expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);

    await runtime.dispose();
  });

  it("evicts a parked question when runtime disposal answers it", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const requests: CodexUserInputRequest[] = [];
    const settled: string[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => requests.push(request),
      onUserInputSettled: (questionId) => settled.push(questionId),
    });

    fake.send({
      jsonrpc: "2.0",
      id: 88,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [],
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await runtime.dispose();

    expect(settled).toEqual([requests[0].questionId]);
  });

  it("evicts a parked question when Codex resolves the server request", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const requests: CodexUserInputRequest[] = [];
    const settled: string[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => requests.push(request),
      onUserInputSettled: (questionId) => settled.push(questionId),
    });

    fake.send({
      jsonrpc: "2.0",
      id: 99,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [],
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    fake.send({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 99 },
    });

    await vi.waitFor(() => expect(settled).toEqual([requests[0].questionId]));
    // `serverRequest/resolved` means Codex already retired request 99. Zeros
    // must release its local handler without writing a stale second response.
    expect(fake.outbound.filter((frame) => frame.id === 99)).toEqual([]);

    await runtime.dispose();
  });

  it("evicts a parked approval when Codex resolves the server request", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const approvals: Array<{ permissionId: string }> = [];
    const settled: string[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onApprovalRequest: (request) => approvals.push(request),
      onApprovalSettled: (permissionId) => settled.push(permissionId),
    });

    fake.send({
      jsonrpc: "2.0",
      id: 101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "git status",
        cwd: "/tmp/project",
      },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    fake.send({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 101 },
    });

    await vi.waitFor(() =>
      expect(settled).toEqual([approvals[0].permissionId]),
    );
    expect(fake.outbound.filter((frame) => frame.id === 101)).toEqual([]);

    await runtime.dispose();
  });

  it("evicts parked server requests when the app-server exits unexpectedly", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const questions: CodexUserInputRequest[] = [];
    const approvals: Array<{ permissionId: string }> = [];
    const settledQuestions: string[] = [];
    const settledApprovals: string[] = [];
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
      onUserInputRequest: (request) => questions.push(request),
      onApprovalRequest: (request) => approvals.push(request),
      onUserInputSettled: (questionId) => settledQuestions.push(questionId),
      onApprovalSettled: (permissionId) => settledApprovals.push(permissionId),
    });

    fake.send({
      jsonrpc: "2.0",
      id: 111,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [],
      },
    });
    fake.send({
      jsonrpc: "2.0",
      id: 112,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
      },
    });
    await vi.waitFor(() => {
      expect(questions).toHaveLength(1);
      expect(approvals).toHaveLength(1);
    });

    fake.crash();

    await vi.waitFor(() => {
      expect(settledQuestions).toEqual([questions[0].questionId]);
      expect(settledApprovals).toEqual([approvals[0].permissionId]);
    });
    expect(fake.outbound.filter((frame) => frame.id === 111)).toEqual([]);
    expect(fake.outbound.filter((frame) => frame.id === 112)).toEqual([]);

    await runtime.dispose();
  });

  it("settles an active turn when Codex reports an unscoped terminal error", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
    });

    const turn = runtime.runTurn({ threadId: "thread-1", input: [] } as never);
    const start = await fake.waitFor(
      (frame) => frame.method === "turn/start" && frame.id != null,
    );
    fake.send({
      jsonrpc: "2.0",
      id: start.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    // Let runTurn install its completion waiter after consuming the ACK.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fake.send({
      jsonrpc: "2.0",
      method: "error",
      params: {
        error: { message: "server failed without turn correlation" },
        willRetry: false,
      },
    });

    await expect(turn).resolves.toMatchObject({
      turnId: "turn-1",
      status: "failed",
    });
    await runtime.dispose();
  });

  it("does not lose an unscoped terminal error that races the turn/start acknowledgement", async () => {
    const fake = createFakeProcess();
    harness.proc = fake.proc;
    const runtime = await bootCodexAppServerRuntime({
      cwd: "/tmp/project",
      clientInfo: { name: "Zeros-test", version: "0.0.0" },
    });

    const turn = runtime.runTurn({ threadId: "thread-1", input: [] } as never);
    const start = await fake.waitFor(
      (frame) => frame.method === "turn/start" && frame.id != null,
    );
    // app-server can emit the terminal notification immediately before the
    // request ACK. There is no turn waiter yet, but it belongs to this call.
    fake.send({
      jsonrpc: "2.0",
      method: "error",
      params: {
        error: { message: "failed while starting turn" },
        willRetry: false,
      },
    });
    fake.send({
      jsonrpc: "2.0",
      id: start.id,
      result: { turn: { id: "turn-raced", status: "inProgress" } },
    });

    await expect(turn).resolves.toMatchObject({
      turnId: "turn-raced",
      status: "failed",
    });
    await runtime.dispose();
  });
});

describe("Codex RPC trace redaction", () => {
  it("redacts prompt input and answers returned to server requests", () => {
    const turnStart = redactCodexRpcLine(
      JSON.stringify({
        method: "turn/start",
        params: { input: [{ type: "text", text: "private prompt" }] },
      }),
    );
    const nativeAnswer = redactCodexRpcLine(
      JSON.stringify({
        id: 7,
        result: { answers: { email: { answers: ["person@example.com"] } } },
      }),
    );
    const mcpAnswer = redactCodexRpcLine(
      JSON.stringify({
        id: 8,
        result: {
          action: "accept",
          content: { token: "top-secret" },
          _meta: null,
        },
      }),
    );
    const mcpRequest = redactCodexRpcLine(
      JSON.stringify({
        id: 9,
        method: "mcpServer/elicitation/request",
        params: {
          mode: "url",
          url: "https://example.com/oauth?state=secret-state",
          requestedSchema: {
            type: "object",
            properties: { token: { default: "secret-default" } },
          },
        },
      }),
    );

    expect(turnStart).not.toContain("private prompt");
    expect(nativeAnswer).not.toContain("person@example.com");
    expect(mcpAnswer).not.toContain("top-secret");
    expect(mcpRequest).not.toMatch(/secret-state|secret-default/);
    expect(turnStart).toContain("redacted");
    expect(nativeAnswer).toContain("redacted");
    expect(mcpAnswer).toContain("redacted");
    expect(mcpRequest).toContain("redacted");
  });
});
