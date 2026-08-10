import { describe, expect, it, vi } from "vitest";

import type { RequestHandler } from "../../shared/jsonrpc";
import {
  buildInitializeCapabilities,
  registerCodexHostRequestHandlers,
} from "../app-server";

function collectHandlers(): {
  handlers: Map<string, RequestHandler>;
  onRequest: (method: string, handler: RequestHandler) => void;
} {
  const handlers = new Map<string, RequestHandler>();
  return {
    handlers,
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe("Codex app-server host requests", () => {
  it("advertises attestation only when a host provider exists", () => {
    expect(buildInitializeCapabilities({ requestAttestation: false })).toEqual({
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true,
      requestAttestation: false,
    });
    expect(buildInitializeCapabilities({ requestAttestation: true })).toEqual({
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true,
      requestAttestation: true,
    });
  });

  it("answers currentTime/read with whole Unix seconds", async () => {
    const { handlers, onRequest } = collectHandlers();
    registerCodexHostRequestHandlers(
      { onRequest },
      { now: () => 1_725_000_000_987 },
    );

    await expect(
      handlers.get("currentTime/read")?.(
        { threadId: "thread-1" },
        { id: 1, method: "currentTime/read" },
      ),
    ).resolves.toEqual({ currentTimeAt: 1_725_000_000 });
  });

  it("routes item/tool/call through a provider-neutral dynamic-tool seam", async () => {
    const { handlers, onRequest } = collectHandlers();
    const onDynamicToolCall = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "workspace ready" }],
    }));
    registerCodexHostRequestHandlers({ onRequest }, { onDynamicToolCall });

    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "workspace",
      tool: "inspect",
      arguments: { path: "README.md" },
    };
    await expect(
      handlers.get("item/tool/call")?.(params, {
        id: 2,
        method: "item/tool/call",
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "workspace ready" }],
    });
    expect(onDynamicToolCall).toHaveBeenCalledWith(params);
  });

  it("fails a dynamic tool call closed without leaking a product-specific host", async () => {
    const { handlers, onRequest } = collectHandlers();
    registerCodexHostRequestHandlers({ onRequest });

    const response = await handlers.get("item/tool/call")?.(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "workspace",
        tool: "inspect",
        arguments: {},
      },
      { id: 3, method: "item/tool/call" },
    );

    expect(response).toMatchObject({ success: false });
    expect(JSON.stringify(response)).not.toMatch(/browser/i);
  });

  it("converts dynamic-tool provider failures into typed tool output", async () => {
    const { handlers, onRequest } = collectHandlers();
    registerCodexHostRequestHandlers(
      { onRequest },
      {
        onDynamicToolCall: async () => {
          throw new Error("provider unavailable");
        },
      },
    );

    await expect(
      handlers.get("item/tool/call")?.(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "inspect",
          arguments: {},
        },
        { id: 4, method: "item/tool/call" },
      ),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Dynamic tool failed: provider unavailable",
        },
      ],
    });
  });

  it("routes and validates external ChatGPT token refresh", async () => {
    const { handlers, onRequest } = collectHandlers();
    const refreshChatgptAuthTokens = vi.fn(async () => ({
      accessToken: "fresh-access-token",
      chatgptAccountId: "workspace-1",
      chatgptPlanType: "plus",
    }));
    registerCodexHostRequestHandlers(
      { onRequest },
      { refreshChatgptAuthTokens },
    );

    await expect(
      handlers.get("account/chatgptAuthTokens/refresh")?.(
        { reason: "unauthorized", previousAccountId: "workspace-1" },
        { id: 5, method: "account/chatgptAuthTokens/refresh" },
      ),
    ).resolves.toEqual({
      accessToken: "fresh-access-token",
      chatgptAccountId: "workspace-1",
      chatgptPlanType: "plus",
    });
    expect(refreshChatgptAuthTokens).toHaveBeenCalledWith({
      reason: "unauthorized",
      previousAccountId: "workspace-1",
    });

    const invalid = collectHandlers();
    registerCodexHostRequestHandlers(
      { onRequest: invalid.onRequest },
      {
        refreshChatgptAuthTokens: async () =>
          ({
            accessToken: "",
            chatgptAccountId: "",
            chatgptPlanType: null,
          }) as {
            accessToken: string;
            chatgptAccountId: string;
            chatgptPlanType: string | null;
          },
      },
    );
    await expect(
      invalid.handlers.get("account/chatgptAuthTokens/refresh")?.(
        { reason: "unauthorized", previousAccountId: null },
        { id: 6, method: "account/chatgptAuthTokens/refresh" },
      ),
    ).rejects.toThrow(/authentication provider.*invalid refresh/i);
  });

  it("routes and validates optional host attestation", async () => {
    const { handlers, onRequest } = collectHandlers();
    registerCodexHostRequestHandlers(
      { onRequest },
      { generateAttestation: vi.fn(async () => ({ token: "v1.opaque" })) },
    );

    await expect(
      handlers.get("attestation/generate")?.(
        {},
        { id: 7, method: "attestation/generate" },
      ),
    ).resolves.toEqual({ token: "v1.opaque" });

    const invalid = collectHandlers();
    registerCodexHostRequestHandlers(
      { onRequest: invalid.onRequest },
      { generateAttestation: async () => ({ token: "" }) },
    );
    await expect(
      invalid.handlers.get("attestation/generate")?.(
        {},
        { id: 8, method: "attestation/generate" },
      ),
    ).rejects.toThrow(/attestation provider.*empty token/i);
  });

  it("does not register external auth or attestation without providers", () => {
    const { handlers, onRequest } = collectHandlers();
    registerCodexHostRequestHandlers({ onRequest });

    expect(handlers.has("account/chatgptAuthTokens/refresh")).toBe(false);
    expect(handlers.has("attestation/generate")).toBe(false);
  });
});
