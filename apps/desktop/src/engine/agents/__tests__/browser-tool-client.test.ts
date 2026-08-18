import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireZerosBrowserHost,
  browserUseEnabledForWorkspace,
  registerCodexBrowserUseSession,
  releaseZerosBrowserConversation,
  resolveBrowserServiceConfig,
  settleCodexBrowserUseTurn,
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
  });

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
    expect(
      stripBrowserServiceCredentials({
        KEEP: "yes",
        ZEROS_BROWSER_SERVICE_URL: "",
        ZEROS_BROWSER_SERVICE_TOKEN: "",
      }),
    ).toEqual({ KEEP: "yes" });
  });

  it("resolves the browser setting without acquiring the Zeros host", () => {
    expect(
      browserUseEnabledForWorkspace("/tmp/project", undefined, "codex"),
    ).toBe(true);
    expect(
      browserUseEnabledForWorkspace("/tmp/project", undefined, "claude"),
    ).toBe(false);
    vi.mocked(opSettingsResolve).mockReturnValue({
      effective: {
        browser: {
          enabled: false,
          codex_enabled: true,
          claude_enabled: false,
          provider: "isolated",
        },
      },
      sources: {},
      warnings: [],
    });
    expect(
      browserUseEnabledForWorkspace("/tmp/project", undefined, "codex"),
    ).toBe(true);
    expect(
      browserUseEnabledForWorkspace("/tmp/project", undefined, "claude"),
    ).toBe(false);
  });

  it("registers the native Codex session with the IAB host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ registered: true }),
    );

    await expect(
      registerCodexBrowserUseSession({
        browserSessionId: "browser_opaque",
        nativeSessionId: "codex-thread-1",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(true);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/v1/providers/codex/register",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      browserSessionId: "browser_opaque",
      nativeSessionId: "codex-thread-1",
    });
  });

  it("settles the native Codex browser turn through the authenticated host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, settled: true }),
    );

    await expect(
      settleCodexBrowserUseTurn({
        browserSessionId: "browser_opaque",
        nativeSessionId: "codex-thread-1",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(true);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/v1/providers/codex/turn-ended",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer service-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      browserSessionId: "browser_opaque",
      nativeSessionId: "codex-thread-1",
    });
  });

  it("rejects an invalid native turn settlement without contacting the host", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      settleCodexBrowserUseTurn({
        browserSessionId: "browser/unsafe",
        nativeSessionId: "codex-thread-1",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("acquires only the opaque IAB host, not a Zeros tool binding", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        version: 1,
        browserSessionId: "browser_opaque",
        capabilities: { codexIab: true },
      }),
    );
    const binding = await acquireZerosBrowserHost({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      workspaceRoot: "/tmp/project",
      env: ENV,
      fetchImpl,
    });

    expect(binding).toEqual({ browserSessionId: "browser_opaque" });
    expect(binding).not.toHaveProperty("definitions");
    expect(binding).not.toHaveProperty("execute");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      owner: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        workspaceRoot: "/tmp/project",
      },
    });
    fetchImpl.mockImplementationOnce(
      async () => new Response(null, { status: 204 }),
    );
    await expect(
      releaseZerosBrowserConversation("workspace-1", "conversation-1"),
    ).resolves.toBe(true);
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("rejects a stale main-process host that does not advertise native Codex IAB", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ version: 1, browserSessionId: "browser_stale" }),
    );
    await expect(
      acquireZerosBrowserHost({
        workspaceId: "workspace-stale",
        conversationId: "conversation-stale",
        workspaceRoot: "/tmp/project",
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("native Codex IAB");
  });

  it("rejects malformed Zeros owner identifiers before contacting the service", async () => {
    await expect(
      acquireZerosBrowserHost({
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
    const pending = acquireZerosBrowserHost({
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
      json({
        version: 1,
        browserSessionId: "browser_race",
        capabilities: { codexIab: true },
      }),
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

  it("does not allocate an IAB host when Browser use is disabled", async () => {
    vi.mocked(opSettingsResolve).mockReturnValue({
      effective: { browser: { enabled: false, provider: "isolated" } },
      sources: {},
      warnings: [],
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      acquireZerosBrowserHost({
        workspaceId: "workspace-disable",
        conversationId: "conversation-disable",
        workspaceRoot: "/tmp/project",
        env: ENV,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unsupported browser host before allocating it", async () => {
    vi.mocked(opSettingsResolve).mockReturnValue({
      effective: { browser: { enabled: true, provider: "remote" } },
      sources: {},
      warnings: [],
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      acquireZerosBrowserHost({
        workspaceId: "workspace-provider",
        conversationId: "conversation-provider",
        workspaceRoot: "/tmp/project",
        env: ENV,
        fetchImpl,
      }),
    ).rejects.toThrow("Unsupported Zeros browser provider setting");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
