import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserDynamicTools,
  browserMcpServerRegistration,
  createBrowserDynamicToolHandler,
  registerCodexBrowserUseSession,
  resolveBrowserAutomationConfig,
} from "../browser-automation-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex browser automation client", () => {
  it("accepts only authenticated loopback bridge configuration", () => {
    expect(
      resolveBrowserAutomationConfig({
        ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
        ZEROS_BROWSER_AUTOMATION_TOKEN: "secret",
      }),
    ).toEqual({ url: "http://127.0.0.1:43123/tool", token: "secret" });
    expect(
      resolveBrowserAutomationConfig({
        ZEROS_BROWSER_AUTOMATION_URL: "https://example.com/tool",
        ZEROS_BROWSER_AUTOMATION_TOKEN: "secret",
      }),
    ).toBeNull();
    expect(
      resolveBrowserAutomationConfig({
        ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
      }),
    ).toBeNull();
  });

  it("advertises a collision-safe Codex browser namespace", () => {
    const tools = browserDynamicTools({
      ZEROS_BROWSER_AUTOMATION_URL: "http://localhost:43123/tool",
      ZEROS_BROWSER_AUTOMATION_TOKEN: "secret",
    });
    expect(tools?.[0]).toMatchObject({
      type: "namespace",
      name: "zeros_browser",
    });
    const namespace = tools?.[0] as {
      tools?: Array<{ name: string }>;
    };
    expect(namespace.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "computer_screenshot",
        "computer_click",
        "computer_type",
        "computer_key",
      ]),
    );
  });

  it("derives the authenticated MCP endpoint for resumed tasks", () => {
    expect(
      browserMcpServerRegistration(
        {
          ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
          ZEROS_BROWSER_AUTOMATION_TOKEN: "host-token",
        },
        { taskId: "zeros-session-1" },
      ),
    ).toEqual({
      name: "zeros_browser",
      transport: "http",
      url: "http://127.0.0.1:43123/mcp?taskId=zeros-session-1",
      bearerTokenEnvVar: "ZEROS_BROWSER_AUTOMATION_TOKEN",
    });
  });

  it("authenticates and maps an item/tool/call through the loopback host", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          success: true,
          contentItems: [{ type: "inputText", text: "Example Domain" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createBrowserDynamicToolHandler(
      {
        ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
        ZEROS_BROWSER_AUTOMATION_TOKEN: "bridge-secret",
      },
      { taskId: "zeros-session-1" },
    );
    expect(handler).toBeDefined();

    await expect(
      handler?.({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "zeros_browser",
        tool: "open",
        arguments: { url: "https://example.com" },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Example Domain" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/tool",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer bridge-secret",
        }),
      }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      threadId: "task:zeros-session-1",
      turnId: "turn-1",
      callId: "call-1",
    });
  });

  it("registers the native Codex thread with the stable Zeros browser task", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ registered: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerCodexBrowserUseSession(
        {
          ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
          ZEROS_BROWSER_AUTOMATION_TOKEN: "bridge-secret",
        },
        { taskId: "zeros-session-1" },
        "codex-thread-1",
      ),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/codex-browser-use/register",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer bridge-secret",
        }),
        body: JSON.stringify({
          taskId: "zeros-session-1",
          sessionId: "codex-thread-1",
        }),
      }),
    );
  });

  it("rejects an unsafe task binding instead of weakening the loopback boundary", () => {
    const env = {
      ZEROS_BROWSER_AUTOMATION_URL: "http://127.0.0.1:43123/tool",
      ZEROS_BROWSER_AUTOMATION_TOKEN: "bridge-secret",
    };
    expect(
      browserMcpServerRegistration(env, { taskId: "bad/task?id" }),
    ).toBeUndefined();
    expect(
      createBrowserDynamicToolHandler(env, { taskId: "bad/task?id" }),
    ).toBeUndefined();
  });
});
