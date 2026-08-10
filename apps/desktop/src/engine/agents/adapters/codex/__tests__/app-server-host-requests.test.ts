import { describe, expect, it, vi } from "vitest";

import {
  buildInitializeCapabilities,
  registerCodexHostRequestHandlers,
} from "../app-server";
import type { RequestHandler } from "../../shared/jsonrpc";

describe("Codex app-server host requests", () => {
  it("advertises attestation only when a real host provider exists", () => {
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
    const handlers = new Map<string, RequestHandler>();
    const onRequest = vi.fn((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
    });

    registerCodexHostRequestHandlers(
      { onRequest },
      { now: () => 1_725_000_000_987 },
    );

    expect(onRequest).toHaveBeenCalledWith(
      "currentTime/read",
      expect.any(Function),
    );
    expect(
      await handlers.get("currentTime/read")?.(
        { threadId: "thread-1" },
        { id: 1, method: "currentTime/read" },
      ),
    ).toEqual({ currentTimeAt: 1_725_000_000 });
  });

  it("routes item/tool/call through the host dynamic-tool handler", async () => {
    const handlers = new Map<string, RequestHandler>();
    const onDynamicToolCall = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "page ready" }],
    }));

    registerCodexHostRequestHandlers(
      {
        onRequest(method, handler) {
          handlers.set(method, handler);
        },
      },
      { onDynamicToolCall },
    );

    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "zeros_browser",
      tool: "snapshot",
      arguments: {},
    };
    await expect(
      handlers.get("item/tool/call")?.(params, {
        id: 1,
        method: "item/tool/call",
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "page ready" }],
    });
    expect(onDynamicToolCall).toHaveBeenCalledWith(params);
  });

  it("fails closed when no dynamic-tool handler is available", async () => {
    const handlers = new Map<string, RequestHandler>();
    registerCodexHostRequestHandlers({
      onRequest(method, handler) {
        handlers.set(method, handler);
      },
    });

    await expect(
      handlers.get("item/tool/call")?.(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "zeros_browser",
          tool: "open",
          arguments: { url: "https://example.com" },
        },
        { id: 1, method: "item/tool/call" },
      ),
    ).resolves.toMatchObject({ success: false });
  });

  it("routes external ChatGPT token refresh through an explicit host provider", async () => {
    const handlers = new Map<string, RequestHandler>();
    const refreshChatgptAuthTokens = vi.fn(async () => ({
      accessToken: "fresh-access-token",
      chatgptAccountId: "workspace-1",
      chatgptPlanType: "plus",
    }));
    registerCodexHostRequestHandlers(
      {
        onRequest(method, handler) {
          handlers.set(method, handler);
        },
      },
      { refreshChatgptAuthTokens },
    );

    await expect(
      handlers.get("account/chatgptAuthTokens/refresh")?.(
        { reason: "unauthorized", previousAccountId: "workspace-1" },
        { id: 1, method: "account/chatgptAuthTokens/refresh" },
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
  });

  it("routes attestation through an explicit host provider and validates responses", async () => {
    const handlers = new Map<string, RequestHandler>();
    registerCodexHostRequestHandlers(
      {
        onRequest(method, handler) {
          handlers.set(method, handler);
        },
      },
      { generateAttestation: vi.fn(async () => ({ token: "v1.opaque" })) },
    );

    await expect(
      handlers.get("attestation/generate")?.({}, {
        id: 2,
        method: "attestation/generate",
      }),
    ).resolves.toEqual({ token: "v1.opaque" });

    const invalid = new Map<string, RequestHandler>();
    registerCodexHostRequestHandlers(
      {
        onRequest(method, handler) {
          invalid.set(method, handler);
        },
      },
      {
        generateAttestation: async () =>
          ({ token: "" }) as { token: string },
      },
    );
    await expect(
      invalid.get("attestation/generate")?.({}, {
        id: 3,
        method: "attestation/generate",
      }),
    ).rejects.toThrow(/attestation.*token/i);
  });

  it("does not register external-auth or attestation requests without providers", () => {
    const handlers = new Map<string, RequestHandler>();
    registerCodexHostRequestHandlers({
      onRequest(method, handler) {
        handlers.set(method, handler);
      },
    });

    expect(handlers.has("account/chatgptAuthTokens/refresh")).toBe(false);
    expect(handlers.has("attestation/generate")).toBe(false);
  });
});
