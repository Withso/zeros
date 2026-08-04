import { describe, expect, it, vi } from "vitest";

import type {
  LoadSessionResponse,
  RequestPermissionRequest,
} from "@zeros/core/agent-events";
import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import { MessageRouter } from "../transport/router";
import type { TransportClient } from "../transport/types";

interface TestEngineInternals {
  router: MessageRouter;
  agents: { loadSession: (...args: unknown[]) => Promise<unknown> };
  sessionAgent: Map<string, string>;
  activePromptContexts: Map<
    string,
    {
      sessionId: string;
      agentId: string;
      chatId: string | null;
      turnId: string;
      startedAt: number;
    }
  >;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  pendingPermissionRequests: Map<
    string,
    { agentId: string; request: RequestPermissionRequest }
  >;
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  handleDisconnect(client: TransportClient): void;
}

function testClient(id = "renderer-1") {
  const messages: EngineMessage[] = [];
  const client: TransportClient = {
    id,
    kind: "local",
    send: (message) => messages.push(message),
    close: vi.fn(),
  };
  return { client, messages };
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
    state.activePromptContexts.set("session-1", {
      sessionId: "session-1",
      agentId: "codex",
      chatId: "chat-1",
      turnId: "user-1",
      startedAt: 1_234,
    });
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
