import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudAgentConnection } from "../cloud-agent-connection";
import type { RuntimeClient } from "../ws-client";
import type { WireRecord } from "../cloud-runtime-wire";

const chat = "11111111-1111-4111-8111-111111111111";
const grant = "22222222-2222-4222-8222-222222222222";
function fixture() {
  let enqueued: WireRecord | undefined;
  let state = "succeeded";
  const request = vi.fn(async (message: WireRecord) => {
    const params = message.params as WireRecord;
    const input = params.request as WireRecord;
    let result: unknown = { conversationId: chat, modeRevision: 0 };
    if (message.op === "cloudCommands.request") {
      if (input.kind === "snapshot")
        result = {
          version: 1,
          conversationId: chat,
          revision: 0,
          paused: false,
          pending: [],
          receipts: [],
        };
      if (input.kind === "mutate")
        enqueued = (input.mutation as WireRecord).action as WireRecord;
      if (input.kind === "read")
        result = {
          commandId: input.commandId,
          position: 1,
          state,
          payload: null,
          executionId: "execution",
          generation: 1,
          resultCode: null,
          createdAt: "2026-09-26T00:00:00Z",
          updatedAt: "2026-09-26T00:00:00Z",
        };
    }
    if (message.op === "cloudEvents.request")
      result = {
        snapshot: {
          conversationId: chat,
          executionId: "reconnected",
          activeTurn: { startedAt: 100 },
          initialize: {
            protocolVersion: 1,
            agentCapabilities: { steering: true },
          },
          session: {
            modes: {
              currentModeId: "ask",
              availableModes: [{ id: "ask", name: "Ask" }],
            },
          },
          permissions: [
            {
              permissionId: "pending",
              agentId: "codex",
              request: {
                sessionId: "reconnected",
                toolCall: { toolCallId: "tool" },
              },
            },
          ],
          questions: [],
        },
      };
    return { type: "WORKSPACE_RESPONSE", op: message.op, result };
  });
  const authorize = vi.fn(async () => grant);
  const connection = new CloudAgentConnection(
    { request, status: "connected" } as unknown as RuntimeClient,
    "local-main",
    authorize,
  );
  return {
    connection,
    request,
    authorize,
    getEnqueued: () => enqueued,
    setState: (value: string) => {
      state = value;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("cloud agent command adapter", () => {
  it("keeps an in-flight prompt bound to the model and effort that were authorized", async () => {
    const f = fixture();
    let authorize!: (value: string) => void;
    f.authorize.mockReturnValueOnce(new Promise(resolve => { authorize = resolve; }));
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6", ZEROS_THINKING_EFFORT: "high" } });
    const pending = f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`,
      userMessageId: "captured-model", prompt: [{ type: "text", text: "test" }] });
    f.connection.send({ type: "AGENT_UPDATE_CONFIG", sessionId: `conversation:${chat}`,
      env: { OPENAI_MODEL: "another-model", ZEROS_THINKING_EFFORT: "max", ZEROS_FAST_MODE: "1" } });
    authorize(grant);
    await pending;
    expect(f.getEnqueued()).toMatchObject({ payload: { model: "gpt-5.6", effort: "high", fast: false } });
    f.connection.dispose();
  });
  it.each(["max", "ultracode"])("preserves the existing %s effort choice in cloud commands", async effort => {
    const f = fixture();
    await f.connection.request({ type: "AGENT_NEW_SESSION", chatId: chat, agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6", ZEROS_THINKING_EFFORT: effort } });
    await f.connection.request({ type: "AGENT_PROMPT", sessionId: `conversation:${chat}`, userMessageId: "effort-message",
      prompt: [{ type: "text", text: "test" }] });
    expect(f.getEnqueued()).toMatchObject({ payload: { effort } });
    f.connection.dispose();
  });
  it("attaches without spawning and submits one authorized durable command for duplicate sends", async () => {
    const f = fixture();
    const created = await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" },
    });
    const sessionId = (created!.session as WireRecord).sessionId;
    expect(
      f.request.mock.calls.every(
        ([message]) => message.type === "WORKSPACE_REQUEST",
      ),
    ).toBe(true);
    const prompt = {
      type: "AGENT_PROMPT",
      sessionId,
      agentId: "codex",
      userMessageId: "message-1",
      prompt: [{ type: "text", text: "hello" }],
    };
    const [one, two] = await Promise.all([
      f.connection.request(prompt),
      f.connection.request(prompt),
    ]);
    expect(one).toEqual(two);
    expect(one?.type).toBe("AGENT_PROMPT_COMPLETE");
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.getEnqueued()).toMatchObject({
      kind: "enqueue",
      payload: {
        agentCredentialGrantId: grant,
        model: "gpt-5.6",
        userMessageId: "message-1",
      },
    });
    f.connection.dispose();
  });

  it("routes live tool notifications and Stop through their conversation", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
    });
    const update = f.connection.incoming({
      type: "AGENT_SESSION_UPDATE",
      chatId: chat,
      executionId: "real-execution",
      notification: {
        sessionId: "real-execution",
        update: { sessionUpdate: "tool_call", toolCallId: "native-tool" },
      },
    });
    expect(update).toMatchObject({
      executionId: `conversation:${chat}`,
      notification: {
        sessionId: `conversation:${chat}`,
        update: { toolCallId: "native-tool" },
      },
    });
    expect(
      f.connection.incoming({
        type: "AGENT_PERMISSION_REQUEST",
        permissionId: "permission",
        request: {
          sessionId: "real-execution",
          toolCall: { toolCallId: "native-tool" },
        },
      }),
    ).toMatchObject({
      chatId: chat,
      request: { sessionId: `conversation:${chat}` },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_CANCEL",
        sessionId: `conversation:${chat}`,
      }),
    ).toMatchObject({
      op: "cloudCommands.request",
      params: { request: { kind: "stop", conversationId: chat } },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_PERMISSION_RESPONSE",
        sessionId: `conversation:${chat}`,
        permissionId: "native-permission",
      }),
    ).toMatchObject({
      sessionId: "real-execution",
      permissionId: "native-permission",
    });
  });

  it("restores an active conversation after reconnect without spawning a replacement", async () => {
    const f = fixture();
    const permissions = vi.fn();
    const metadata = vi.fn();
    f.connection.on("AGENT_PERMISSION_REQUEST", permissions);
    f.connection.on("AGENT_SESSION_CREATED", metadata);
    const response = await f.connection.request({
      type: "AGENT_LOAD_SESSION",
      chatId: chat,
      agentId: "codex",
      providerBinding: { resume: { id: "native" } },
    });
    expect(response).toMatchObject({
      type: "AGENT_SESSION_LOADED",
      promptActive: true,
      activeTurnStartedAt: 100,
      response: { providerBinding: { resume: { id: "native" } } },
    });
    expect(
      f.connection.outgoing({
        type: "AGENT_PERMISSION_RESPONSE",
        sessionId: `conversation:${chat}`,
      }),
    ).toMatchObject({ sessionId: "reconnected" });
    expect(
      f.request.mock.calls.some(
        ([message]) => message.type === "AGENT_NEW_SESSION",
      ),
    ).toBe(false);
    expect(
      f.request.mock.calls.some(
        ([message]) => message.op === "cloudCommands.createConversation",
      ),
    ).toBe(false);
    await vi.waitFor(() => expect(permissions).toHaveBeenCalledOnce());
    expect(metadata).toHaveBeenCalledOnce();
    expect(f.connection.incoming(metadata.mock.calls[0][0])).toMatchObject({
      chatId: chat,
      session: {
        executionId: `conversation:${chat}`,
        modes: { currentModeId: "ask" },
      },
      initialize: { agentCapabilities: { steering: true } },
    });
    expect(f.connection.incoming(permissions.mock.calls[0][0])).toMatchObject({
      permissionId: "pending",
      chatId: chat,
      request: {
        sessionId: `conversation:${chat}`,
        toolCall: { toolCallId: "tool" },
      },
    });
    f.connection.dispose();
  });

  it("keeps loaded session metadata on the same attachment route", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
    });
    expect(
      f.connection.incoming({
        type: "AGENT_SESSION_LOADED",
        chatId: chat,
        executionId: "real",
        response: {
          executionId: "real",
          providerBinding: { resumeId: "opaque" },
        },
      }),
    ).toMatchObject({
      executionId: `conversation:${chat}`,
      response: {
        executionId: `conversation:${chat}`,
        providerBinding: { resumeId: "opaque" },
      },
    });
    f.connection.dispose();
  });

  it("does not enqueue when authorization fails or replay an uncertain command", async () => {
    const f = fixture();
    await f.connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: chat,
      agentId: "codex",
      env: { OPENAI_MODEL: "gpt-5.6" },
    });
    f.authorize.mockRejectedValueOnce(new Error("authorization required"));
    const message = {
      type: "AGENT_PROMPT",
      sessionId: `conversation:${chat}`,
      userMessageId: "message-1",
      prompt: [{ type: "text", text: "hello" }],
    };
    await expect(f.connection.request(message)).rejects.toThrow(
      "authorization required",
    );
    expect(f.getEnqueued()).toBeUndefined();
    f.setState("uncertain");
    expect(await f.connection.request(message)).toMatchObject({
      type: "AGENT_PROMPT_FAILED",
      error: expect.stringContaining("unknown"),
    });
  });
});
