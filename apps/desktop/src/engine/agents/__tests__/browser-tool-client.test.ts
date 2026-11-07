import { initialAgentControlAvailability } from "@zeros/protocol/agent-control-rollout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAgentControlAvailability } from "../../agent-control/availability";
import {
  acquireZerosBrowserToolSession,
  browserRouteForWorkspace,
  claudeChromeEnabledForWorkspace,
  invokeZerosBrowserTool,
  releaseZerosBrowserConversation,
  resolveBrowserServiceConfig,
  stopZerosBrowserAction,
  stripBrowserServiceCredentials,
} from "../../browser/browser-tool-client";
import { opSettingsResolve } from "../../settings/ops";

vi.mock("../../settings/ops", () => ({
  opSettingsResolve: vi.fn(() => ({
    effective: { browser: { enabled: true, provider: "isolated" } },
    sources: {},
    warnings: [],
  })),
}));

const ENV = {
  ZEROS_BROWSER_SERVICE_URL: "http://127.0.0.1:43123",
  ZEROS_BROWSER_SERVICE_TOKEN: "service-secret",
};

describe("Zeros browser tool client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(opSettingsResolve).mockReturnValue({
      effective: { browser: { enabled: true, provider: "isolated" } },
      sources: {},
      warnings: [],
    });
    setAgentControlAvailability({
      zerosBrowser: true,
      computerUse: true,
      simulators: true,
      localOrchestration: true,
    });
  });
  afterEach(() =>
    setAgentControlAvailability(initialAgentControlAvailability()),
  );

  it("accepts only credential-free loopback service URLs", () => {
    expect(resolveBrowserServiceConfig(ENV)).toEqual({
      baseUrl: "http://127.0.0.1:43123",
      token: "service-secret",
    });
    expect(
      resolveBrowserServiceConfig({
        ...ENV,
        ZEROS_BROWSER_SERVICE_URL: "https://example.com",
      }),
    ).toBeNull();
    expect(
      resolveBrowserServiceConfig({
        ...ENV,
        ZEROS_BROWSER_SERVICE_URL: "http://127.0.0.1:43123/hidden",
      }),
    ).toBeNull();
  });

  it("removes the host capability from provider subprocess environments", () => {
    expect(
      stripBrowserServiceCredentials({
        KEEP: "yes",
        ZEROS_BROWSER_SERVICE_URL: "http://127.0.0.1:1",
        ZEROS_BROWSER_SERVICE_TOKEN: "secret",
        ZEROS_DESIGN_CAPTURE_URL: "http://127.0.0.1:2",
        ZEROS_DESIGN_CAPTURE_TOKEN: "fixture-private-capture",
        ZEROS_DESIGN_CAPTURE_RENDERER: "electron-0/chromium-0",
        ZEROS_AGENT_CONTROL_SERVICE_URL: "http://127.0.0.1:3",
        ZEROS_AGENT_CONTROL_SERVICE_TOKEN: "control-secret",
      }),
    ).toEqual({ KEEP: "yes" });
    expect(
      stripBrowserServiceCredentials({
        KEEP: "yes",
        ZEROS_BROWSER_SERVICE_URL: "",
        ZEROS_BROWSER_SERVICE_TOKEN: "",
      }),
    ).toEqual({ KEEP: "yes" });
  });

  it("turns on Claude's Chrome only when browser use and Chrome are on", () => {
    const resolveWith = (browser: Record<string, unknown>) =>
      vi.mocked(opSettingsResolve).mockReturnValue({
        effective: { browser },
        sources: {},
        warnings: [],
      });
    resolveWith({ enabled: true });
    expect(claudeChromeEnabledForWorkspace("/tmp/project")).toBe(false);
    resolveWith({ enabled: true, claude_enabled: true });
    expect(claudeChromeEnabledForWorkspace("/tmp/project")).toBe(true);
    // "Enable browser use" decides for every agent, Chrome included.
    resolveWith({ enabled: false, claude_enabled: true });
    expect(claudeChromeEnabledForWorkspace("/tmp/project")).toBe(false);
  });

  it("rejects malformed Zeros owner identifiers before contacting the service", async () => {
    await expect(
      acquireZerosBrowserToolSession({
        workspaceId: "workspace/unsafe",
        conversationId: "codex-thread-1",
        workspaceRoot: "/tmp/project",
        env: ENV,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("workspace identity");
  });

  it("does not publish an acquire that loses a conversation-delete race", async () => {
    let resolveAcquire!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAcquire = resolve;
      });
    });
    const pending = acquireZerosBrowserToolSession({
      workspaceId: "workspace-race",
      conversationId: "conversation-race",
      workspaceRoot: "/tmp/project",
      env: ENV,
      fetchImpl,
    });

    await expect(
      releaseZerosBrowserConversation("workspace-race", "conversation-race"),
    ).resolves.toBe(false);
    resolveAcquire(
      json({ version: 1, browserSessionId: "browser_race" }),
    );

    await expect(pending).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("releases by durable owner after an engine restart loses the opaque binding", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("/v1/sessions/release");
      return json({ version: 1, released: true });
    });

    await expect(
      releaseZerosBrowserConversation(
        "workspace-orphan",
        "conversation-orphan",
        {
          env: ENV,
          fetchImpl,
        },
      ),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      workspaceId: "workspace-orphan",
      conversationId: "conversation-orphan",
    });
  });

  it("routes each agent from the workspace browser settings", () => {
    const resolveWith = (browser: Record<string, unknown>) =>
      vi.mocked(opSettingsResolve).mockReturnValue({
        effective: { browser },
        sources: {},
        warnings: [],
      });
    resolveWith({ enabled: true });
    for (const agent of ["codex", "claude", "cursor"]) {
      expect(browserRouteForWorkspace(agent, "/tmp/project")).toBe("zeros");
    }
    resolveWith({ enabled: true, claude_enabled: true });
    expect(browserRouteForWorkspace("codex", "/tmp/project")).toBe("zeros");
    expect(browserRouteForWorkspace("claude", "/tmp/project")).toBe("claude-chrome");
    expect(browserRouteForWorkspace("cursor", "/tmp/project")).toBe("zeros");
    resolveWith({ enabled: false, claude_enabled: true });
    for (const agent of ["codex", "claude", "cursor"]) {
      expect(browserRouteForWorkspace(agent, "/tmp/project")).toBe("off");
    }
    // Retired keys, including a hand-written host backend, change nothing.
    resolveWith({ enabled: true, provider: "remote", codex_native: true, in_app_enabled: false });
    for (const agent of ["codex", "claude", "cursor"]) {
      expect(browserRouteForWorkspace(agent, "/tmp/project")).toBe("zeros");
    }
    // While the Zeros browser is closed, only Claude's chosen Chrome remains.
    setAgentControlAvailability({ ...initialAgentControlAvailability(), zerosBrowser: false });
    resolveWith({ enabled: true, claude_enabled: true });
    expect(browserRouteForWorkspace("codex", "/tmp/project")).toBe("off");
    expect(browserRouteForWorkspace("claude", "/tmp/project")).toBe("claude-chrome");
  });

  it("acquires a tool session without the Codex switch or its IAB capability", async () => {
    vi.mocked(opSettingsResolve).mockReturnValue({
      effective: { browser: { codex_enabled: false, provider: "isolated" } },
      sources: {},
      warnings: [],
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, browserSessionId: "browser_tools" }),
    );

    await expect(
      acquireZerosBrowserToolSession({
        workspaceId: "workspace-tools",
        conversationId: "conversation-tools",
        workspaceRoot: "/tmp/project",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toEqual({ browserSessionId: "browser_tools" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43123/v1/sessions/acquire",
    );
    await expect(
      acquireZerosBrowserToolSession({
        workspaceId: "workspace-tools",
        conversationId: "conversation-tools",
        workspaceRoot: "/tmp/project",
        env: {},
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("invokes one browser tool through the authenticated host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        version: 1,
        success: true,
        content: [
          { type: "text", text: '{"url":"https://example.com/"}' },
          { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        ],
      }),
    );

    await expect(
      invokeZerosBrowserTool({
        browserSessionId: "browser_tools",
        tool: "open",
        arguments: { url: "https://example.com" },
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toEqual({
      version: 1,
      success: true,
      content: [
        { type: "text", text: '{"url":"https://example.com/"}' },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43123/v1/sessions/browser_tools/invoke",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer service-secret",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      tool: "open",
      arguments: { url: "https://example.com" },
    });
  });

  it("names the agent driving the page for the host's control bar", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, success: true, content: [] }),
    );
    await invokeZerosBrowserTool({
      browserSessionId: "browser_tools",
      tool: "snapshot",
      arguments: {},
      agent: "codex",
      env: ENV,
      fetchImpl,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      tool: "snapshot",
      arguments: {},
      agent: "codex",
    });
    await expect(
      invokeZerosBrowserTool({
        browserSessionId: "browser_tools",
        tool: "snapshot",
        arguments: {},
        agent: "droid" as never,
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("Invalid Zeros browser tool request");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an unknown tool, an unsafe session id and a malformed result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, success: true, content: [{ type: "video" }] }),
    );
    await expect(
      invokeZerosBrowserTool({
        browserSessionId: "browser_tools",
        tool: "evaluate" as never,
        arguments: {},
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("Invalid Zeros browser tool request");
    await expect(
      invokeZerosBrowserTool({
        browserSessionId: "browser/../escape",
        tool: "snapshot",
        arguments: {},
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("Invalid Zeros browser tool request");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      invokeZerosBrowserTool({
        browserSessionId: "browser_tools",
        tool: "snapshot",
        arguments: {},
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("invalid tool result");
  });

  it("aborts an in-flight invoke with the caller's signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    const pending = invokeZerosBrowserTool({
      browserSessionId: "browser_tools",
      tool: "wait",
      arguments: { seconds: 5 },
      signal: controller.signal,
      env: ENV,
      fetchImpl,
    });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("stops the current browser action without closing the page", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, stopped: true }),
    );
    await expect(
      stopZerosBrowserAction({
        browserSessionId: "browser_tools",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:43123/v1/sessions/browser_tools/stop",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
    });
    await expect(
      stopZerosBrowserAction({
        browserSessionId: "browser/../escape",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
