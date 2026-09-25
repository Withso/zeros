import { describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import { ZerosEngine } from "../zeros-engine";

describe("retired title bridge compatibility", () => {
  it("answers older clients without touching provider credentials or runtimes", async () => {
    const state = Object.create(ZerosEngine.prototype) as {
      handleAgentMessage(
        message: EngineMessage,
        client: TransportClient,
      ): Promise<void>;
    };
    const send = vi.fn();
    await state.handleAgentMessage(
      {
        type: "AGENT_GENERATE_TITLE",
        id: "legacy-request",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        model: "old-model",
        systemPrompt: "Old instructions",
        prompt: "Private prompt",
        env: { OPENAI_API_KEY: "synthetic-unadmitted-key" },
      },
      { id: "renderer", kind: "local", send, close: vi.fn() },
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "AGENT_TITLE_GENERATED",
        requestId: "legacy-request",
        agentId: "codex",
        title: null,
      }),
    );
  });
});
