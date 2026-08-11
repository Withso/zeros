import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireZerosBrowserTools,
  releaseZerosBrowserConversation,
  resolveBrowserServiceConfig,
  stripBrowserServiceCredentials,
} from "../../browser/browser-tool-client";

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
  beforeEach(() => vi.clearAllMocks());

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
      }),
    ).toEqual({ KEEP: "yes" });
  });

  it("acquires by Zeros workspace and conversation and invokes the opaque id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/acquire")) {
        return json({ version: 1, browserSessionId: "browser_opaque" });
      }
      return json({
        version: 1,
        success: true,
        content: [{ type: "text", text: "Example Domain" }],
      });
    });
    const binding = await acquireZerosBrowserTools({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      workspaceRoot: "/tmp/project",
      env: ENV,
      fetchImpl,
    });

    expect(binding?.browserSessionId).toBe("browser_opaque");
    expect(
      binding?.definitions.map((definition) => definition.name),
    ).not.toContain("cdp");
    await expect(binding?.execute("snapshot", {})).resolves.toMatchObject({
      success: true,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      owner: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        workspaceRoot: "/tmp/project",
      },
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/v1/sessions/browser_opaque/invoke",
    );
    fetchImpl.mockImplementationOnce(
      async () => new Response(null, { status: 204 }),
    );
    await expect(
      releaseZerosBrowserConversation("workspace-1", "conversation-1"),
    ).resolves.toBe(true);
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  it("rejects malformed Zeros owner identifiers before contacting the service", async () => {
    await expect(
      acquireZerosBrowserTools({
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
    const pending = acquireZerosBrowserTools({
      workspaceId: "workspace-race",
      conversationId: "conversation-race",
      workspaceRoot: "/tmp/project",
      env: ENV,
      fetchImpl,
    });

    await expect(
      releaseZerosBrowserConversation("workspace-race", "conversation-race"),
    ).resolves.toBe(false);
    resolveAcquire(json({ version: 1, browserSessionId: "browser_race" }));

    await expect(pending).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
