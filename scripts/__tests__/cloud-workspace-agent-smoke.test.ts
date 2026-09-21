import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { qualifyAgent } from "../cloud-workspace-validation/agent-smoke";
import { parseCloudAgentSelections } from "../cloud-workspace-validation/lib/qualification-gates";
import type {
  BridgeMessage,
  ClientBridgeMessage,
} from "../cloud-workspace-validation/lib/bridge-client";

const selection = parseCloudAgentSelections(
  ["cursor"],
  '{"cursor":{"model":"grok-4.6","effort":"xhigh"}}',
)[0];

function fixture(options?: { validBoundary: boolean; model: string }) {
  const handlers = new Set<(message: BridgeMessage) => void>();
  const client = {
    onMessage(listener: (message: BridgeMessage) => void) {
      handlers.add(listener);
      return () => {
        handlers.delete(listener);
      };
    },
    sendMessage: vi.fn((fields: ClientBridgeMessage) => {
      const requestId = randomUUID();
      queueMicrotask(() => {
        if (fields.type === "AGENT_PROMPT") {
          const marker =
            JSON.stringify(fields).match(/ZEROS_PING_[A-Z0-9]+/)?.[0] ?? "";
          for (const handler of handlers)
            handler({
              type: "AGENT_SESSION_UPDATE",
              agentId: "cursor",
              executionId: "test-execution",
              notification: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: marker },
                },
              },
            } as BridgeMessage);
          for (const handler of handlers)
            handler({
              type: "AGENT_PROMPT_COMPLETE",
              requestId,
              response: { effectiveModel: options?.model },
            } as BridgeMessage);
          return;
        }
        const message =
          fields.type === "AGENT_NEW_SESSION"
            ? {
                type: "AGENT_SESSION_CREATED",
                requestId,
                session: {
                  executionId: "test-execution",
                  boundary: options?.validBoundary
                    ? {
                        version: 1,
                        actor: "agent-code",
                        state: "ready",
                        backend: "cloud-worker",
                        designProtection: {
                          required: true,
                          enforced: true,
                          protectedDirectoryCount: 1,
                        },
                        parity: { level: "full", restrictions: [] },
                      }
                    : null,
                },
              }
            : { type: "AGENT_SESSION_CLOSED", requestId };
        for (const handler of handlers) handler(message as BridgeMessage);
      });
      return requestId;
    }),
  };
  return { client, handlers };
}

describe("paid cloud agent qualification cleanup", () => {
  it("observes a failed durable admission even when no provider frame exists", async () => {
    const { client, handlers } = fixture();
    const request = vi.fn(
      async (op: string, params: Record<string, unknown>) => {
        if (op === "cloudCommands.createConversation") return {};
        const input = params.request as { kind: string };
        if (input.kind === "read") return { state: "failed" };
        return { revision: 0 };
      },
    );
    await expect(
      qualifyAgent(
        { ...client, request, engineCapabilities: ["cloud.commands.v1"] },
        { ...selection, agentCredentialGrantId: randomUUID() },
        "workspace",
        50,
      ),
    ).rejects.toThrow(/durably settle/);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      request: { kind: "read" },
    });
    expect(
      request.mock.calls.some(
        ([, params]) =>
          (params.request as { kind: string } | undefined)?.kind === "stop",
      ),
    ).toBe(true);
    expect(handlers.size).toBe(0);
  });
  it("admits cold turns with delegated credentials, verifies continuation and durably stops cleanup", async () => {
    const { client, handlers } = fixture({
      validBoundary: true,
      model: "grok-4.6",
    });
    let commandId = "",
      marker = "",
      revision = 0,
      turns = 0;
    const grantId = randomUUID();
    const request = vi.fn(
      async (op: string, params: Record<string, unknown>) => {
        if (op === "cloudCommands.createConversation") return {};
        const input = params.request as {
          kind: string;
          commandId?: string;
          mutation: {
            conversationId: string;
            expectedRevision: number;
            action: { commandId: string; payload: unknown };
          };
        };
        if (input.kind === "snapshot") return { revision };
        if (input.kind === "read") {
          expect(input.commandId).toBe(commandId);
          return { state: "succeeded" };
        }
        if (input.kind === "stop")
          return { paused: true, revision: ++revision };
        expect(input.mutation.expectedRevision).toBe(revision);
        expect(input.mutation.action.payload).toMatchObject({
          agentId: "cursor",
          model: "grok-4.6",
          agentCredentialGrantId: grantId,
          effort: "xhigh",
          fast: false,
        });
        commandId = input.mutation.action.commandId;
        turns++;
        if (turns === 1)
          marker = JSON.stringify(params).match(/ZEROS_PING_[A-Z0-9]+/)![0];
        else expect(JSON.stringify(params)).not.toContain(marker);
        const executionId = `test-execution-${turns}`;
        queueMicrotask(() => {
          const publish = (message: unknown) => {
            for (const handler of handlers) handler(message as BridgeMessage);
          };
          publish({
            type:
              turns === 1 ? "AGENT_SESSION_CREATED" : "AGENT_SESSION_LOADED",
            requestId: commandId,
            agentId: "cursor",
            session: {
              executionId,
              boundary: {
                version: 1,
                actor: "agent-code",
                state: "ready",
                backend: "cloud-worker",
                designProtection: {
                  required: true,
                  enforced: true,
                  protectedDirectoryCount: 1,
                },
                parity: { level: "full", restrictions: [] },
              },
            },
          });
          publish({
            type: "AGENT_SESSION_UPDATE",
            agentId: "cursor",
            executionId,
            notification: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: marker },
              },
            },
          });
          publish({
            type: "AGENT_PROMPT_COMPLETE",
            requestId: commandId,
            response: { effectiveModel: "grok-4.6" },
          });
        });
        return { revision: ++revision };
      },
    );
    await qualifyAgent(
      { ...client, request, engineCapabilities: ["cloud.commands.v1"] },
      { ...selection, agentCredentialGrantId: grantId },
      "workspace",
      1000,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(turns).toBe(2);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      request: { kind: "stop" },
    });
    expect(handlers.size).toBe(0);
  });

  it("requires a credential delegation before starting a durable qualification", async () => {
    const { client } = fixture();
    const request = vi.fn();
    await expect(
      qualifyAgent(
        { ...client, request, engineCapabilities: ["cloud.commands.v1"] },
        selection,
        "workspace",
        1000,
      ),
    ).rejects.toThrow(/delegation/i);
    expect(request).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an unexpected reported model even when the live challenge succeeds", async () => {
    const { client, handlers } = fixture({
      validBoundary: true,
      model: "another-model",
    });
    await expect(
      qualifyAgent(client, selection, "workspace", 1000),
    ).rejects.toThrow(/selected model/);
    expect(client.sendMessage.mock.calls.at(-1)?.[0].type).toBe(
      "AGENT_CLOSE_SESSION",
    );
    expect(handlers.size).toBe(0);
  });
  it("closes an admitted session when its boundary assertion fails, without prompting", async () => {
    const { client, handlers } = fixture();
    await expect(
      qualifyAgent(client, selection, "workspace", 1000),
    ).rejects.toThrow(/boundary/);
    expect(
      client.sendMessage.mock.calls.map(([message]) => message.type),
    ).toEqual(["AGENT_NEW_SESSION", "AGENT_CLOSE_SESSION"]);
    expect(handlers.size).toBe(0);
  });

  it("releases response listeners immediately if the bridge send throws", async () => {
    const { client, handlers } = fixture();
    client.sendMessage.mockImplementation(() => {
      throw new Error("closed bridge");
    });
    await expect(
      qualifyAgent(client, selection, "workspace", 1000),
    ).rejects.toThrow(/closed bridge/);
    expect(handlers.size).toBe(0);
  });
});
