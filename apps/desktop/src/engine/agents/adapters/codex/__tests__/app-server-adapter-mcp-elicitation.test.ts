import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext, QuestionResponse } from "../../../types";
import type {
  CodexAppServerBootOptions,
  CodexMcpElicitationRequest,
} from "../app-server";

const rt = vi.hoisted(() => ({
  bootOptions: null as CodexAppServerBootOptions | null,
  mcpResponses: [] as Array<{ questionId: string; response: unknown }>,
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async (opts: CodexAppServerBootOptions) => {
    rt.bootOptions = opts;
    return {
      initializeResponse: {
        userAgent: "codex_cli 0.146.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos",
      },
      cliVersion: "0.146.0",
      binarySource: { source: "override", path: "codex" },
      child: { pid: 1234, killed: false },
      startThread: async () => ({
        threadId: "thread-1",
        model: "gpt-5",
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        raw: {},
      }),
      resumeThread: async (params: { threadId: string }) => ({
        threadId: params.threadId,
        model: "gpt-5",
        raw: {},
      }),
      runTurn: async () => ({
        turnId: "turn-1",
        status: "completed",
        raw: {},
      }),
      interruptTurn: async () => {},
      respondToPermission: () => {},
      respondToUserInput: () => {},
      respondToMcpElicitation: (questionId: string, response: unknown) => {
        rt.mcpResponses.push({ questionId, response });
      },
      onNotification: () => () => {},
      request: vi.fn(async () => ({})),
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

function makeAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onPermissionSettled: vi.fn(),
    onQuestionRequest: vi.fn(),
    onQuestionSettled: vi.fn(),
    onAgentStderr: vi.fn(),
    onAgentExit: vi.fn(),
  };
  const context: AgentAdapterContext = {
    projectRoot: "/tmp/project",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit,
  };
  return { adapter: new CodexAppServerAdapter(context), emit };
}

function formRequest(
  questionId = "mcp-question-1",
): CodexMcpElicitationRequest {
  return {
    questionId,
    requestId: "mcp-native-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "calendar",
      mode: "form",
      message: "Create the calendar event",
      _meta: null,
      requestedSchema: {
        type: "object",
        required: ["attendees", "reminders"],
        properties: {
          attendees: {
            type: "integer",
            title: "Attendees",
            minimum: 1,
            maximum: 50,
          },
          visibility: {
            type: "string",
            title: "Visibility",
            enum: ["private", "public"],
            enumNames: ["Private", "Public"],
          },
          reminders: {
            type: "boolean",
            title: "Send reminders",
          },
          labels: {
            type: "array",
            items: { type: "string", enum: ["work", "travel"] },
          },
        },
      },
    },
  };
}

describe("Codex MCP elicitation bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.bootOptions = null;
    rt.mcpResponses = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("projects a typed form and reconstructs structured MCP content", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/project" });
    rt.bootOptions?.onMcpElicitationRequest?.(formRequest());

    const [, questionId, request] = emit.onQuestionRequest.mock.calls[0];
    expect(questionId).toBe("mcp-question-1");
    expect(request.sessionId).toBe(session.sessionId);
    expect(request.nativeRequestId).toContain("mcp-native-1");
    expect(request.questions).toHaveLength(4);
    expect(request.questions[0]).toMatchObject({
      id: "attendees",
      multiSelect: false,
      allowOther: true,
    });
    expect(request.questions[1].options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "private", label: "Private" }),
        expect.objectContaining({ id: "__zeros_mcp_omit__:visibility" }),
      ]),
    );
    expect(request.questions[3]).toMatchObject({
      id: "labels",
      multiSelect: true,
      allowOther: false,
    });

    const response: QuestionResponse = {
      outcome: {
        outcome: "answered",
        answers: [
          {
            questionId: "attendees",
            selectedOptionIds: [],
            freeText: "12",
          },
          {
            questionId: "visibility",
            selectedOptionIds: ["private"],
          },
          {
            questionId: "reminders",
            selectedOptionIds: ["true"],
          },
          {
            questionId: "labels",
            selectedOptionIds: ["work", "travel"],
          },
        ],
      },
    };
    expect(adapter.respondToQuestion({ questionId, response })).toBe(true);

    expect(rt.mcpResponses).toEqual([
      {
        questionId: "mcp-question-1",
        response: {
          action: "accept",
          content: {
            attendees: 12,
            visibility: "private",
            reminders: true,
            labels: ["work", "travel"],
          },
          _meta: null,
        },
      },
    ]);
    expect(emit.onQuestionSettled).toHaveBeenCalledWith(
      "codex",
      "mcp-question-1",
      session.sessionId,
      response.outcome,
    );
  });

  it("surfaces a safe URL flow and evicts it when Codex resolves it elsewhere", async () => {
    const { adapter, emit } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/project" });
    const request: CodexMcpElicitationRequest = {
      questionId: "mcp-url-1",
      requestId: 17,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "calendar",
        mode: "url",
        message: "Authorize calendar access",
        url: "https://example.com/authorize",
        elicitationId: "elicitation-1",
        _meta: null,
      },
    };
    rt.bootOptions?.onMcpElicitationRequest?.(request);

    const [, , canonical] = emit.onQuestionRequest.mock.calls[0];
    expect(canonical.questions[0].options[0]).toMatchObject({
      id: "accept",
      preview: "https://example.com/authorize",
    });

    rt.bootOptions?.onMcpElicitationSettled?.("mcp-url-1");

    expect(emit.onQuestionSettled).toHaveBeenCalledWith(
      "codex",
      "mcp-url-1",
      session.sessionId,
      { outcome: "dismissed" },
    );
    expect(rt.mcpResponses).toEqual([]);
    expect(
      adapter.respondToQuestion({
        questionId: "mcp-url-1",
        response: { outcome: { outcome: "dismissed" } },
      }),
    ).toBe(false);
  });
});
