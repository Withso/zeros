import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  agentControlUnavailableReason,
  initialAgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import {
  BROWSER_TOOL_NAMES,
  type BrowserRoute,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../git";
import type { AgentSessionToolInput } from "../../agents/session-tools";
import {
  AgentControlToolAdmissions,
  ZEROS_BROWSER_TOOLS_ENV,
} from "../admission";
import { setAgentControlAvailability } from "../availability";
import {
  ZerosBrowserTools,
  zerosBrowserToolPolicy,
  type ZerosBrowserToolPorts,
} from "../zeros-browser-tools";

const OK: BrowserToolResult = {
  version: 1,
  success: true,
  content: [
    { type: "text", text: '{"url":"https://example.com/"}' },
    { type: "image", data: "AAAA", mimeType: "image/jpeg" },
  ],
};

function ports(overrides: Partial<ZerosBrowserToolPorts> = {}) {
  return {
    policy: vi.fn(() => ({ ok: true as const })),
    acquire: vi.fn(async () => ({ browserSessionId: "browser_one" })),
    invoke: vi.fn(async () => OK),
    stop: vi.fn(async () => true),
    ...overrides,
  } satisfies ZerosBrowserToolPorts;
}

describe("zeros_browser routing policy", () => {
  it.each<[string, BrowserRoute, boolean, RegExp?]>([
    // Codex keeps the tools only when its built-in browser is off or broken;
    // the adapter removes them when the built-in browser loads.
    ["codex", "codex-native", true],
    ["codex", "zeros", true],
    ["codex", "off", false, /turned off for Codex/],
    ["claude", "zeros", true],
    ["claude", "claude-chrome", false, /Claude is set to use Chrome/],
    ["claude", "off", false, /in-app browser is turned off/],
    ["cursor", "zeros", true],
    ["cursor", "off", false, /in-app browser is turned off/],
  ])("%s with route %s → allowed %s", (family, route, ok, reason) => {
    const policy = zerosBrowserToolPolicy(family, route);
    expect(policy.ok).toBe(ok);
    if (!policy.ok) expect(policy.reason).toMatch(reason!);
  });
});

describe("zeros_browser tools", () => {
  it("lists the semantic browser tools only while the agent may use them", () => {
    const port = ports();
    const tools = new ZerosBrowserTools(port);
    expect(tools.listTools().map((tool) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
    ]);
    for (const tool of tools.listTools()) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    vi.mocked(port.policy).mockReturnValue({ ok: false, reason: "off" });
    expect(tools.listTools()).toEqual([]);
  });

  it("runs a tool in the conversation's browser and returns text and images", async () => {
    const port = ports();
    const tools = new ZerosBrowserTools(port);
    const result = await tools.callTool(
      "open",
      { url: "https://example.com" },
      new AbortController().signal,
    );
    expect(port.acquire).toHaveBeenCalledOnce();
    expect(port.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSessionId: "browser_one",
        tool: "open",
        arguments: { url: "https://example.com" },
      }),
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: '{"url":"https://example.com/"}' },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ],
    });
  });

  it("reports a failed browser action as an MCP error result", async () => {
    const tools = new ZerosBrowserTools(
      ports({
        invoke: vi.fn(async () => ({
          version: 1 as const,
          success: false,
          content: [{ type: "text" as const, text: "Element not found." }],
        })),
      }),
    );
    await expect(
      tools.callTool("click", { ref: "b1" }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Element not found." }],
      isError: true,
    });
  });

  it("refuses a call after Settings turned the browser off, without touching it", async () => {
    const port = ports({
      policy: vi.fn(() => ({
        ok: false as const,
        reason: "Browser use is turned off for Codex in Settings > Browser.",
      })),
    });
    const tools = new ZerosBrowserTools(port);
    await expect(
      tools.callTool("snapshot", {}, new AbortController().signal),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Browser use is turned off for Codex in Settings > Browser.",
        },
      ],
      isError: true,
    });
    expect(port.acquire).not.toHaveBeenCalled();
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and non-object arguments", async () => {
    const port = ports();
    const tools = new ZerosBrowserTools(port);
    const signal = new AbortController().signal;
    await expect(tools.callTool("evaluate", {}, signal)).resolves.toMatchObject(
      { isError: true },
    );
    await expect(
      tools.callTool("open", ["https://example.com"], signal),
    ).resolves.toMatchObject({ isError: true });
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("stops the browser action when the provider cancels the call", async () => {
    const port = ports({
      invoke: vi.fn(
        ({ signal }) =>
          new Promise<BrowserToolResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    });
    const tools = new ZerosBrowserTools(port);
    const controller = new AbortController();
    const pending = tools.callTool("wait", { seconds: 5 }, controller.signal);
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(port.stop).toHaveBeenCalledWith("browser_one");
  });

  it("Stop cancels in-flight browser work for the whole turn", async () => {
    const port = ports({
      invoke: vi.fn(
        ({ signal }) =>
          new Promise<BrowserToolResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    });
    const tools = new ZerosBrowserTools(port);
    const pending = tools.callTool(
      "open",
      { url: "https://example.com" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    tools.cancel();
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "Browser work was stopped." }],
      isError: true,
    });
    expect(port.stop).toHaveBeenCalledWith("browser_one");
  });

  it("hands the page back to the user at turn end only after the agent used it", async () => {
    const port = ports();
    const tools = new ZerosBrowserTools(port);
    await tools.endPrompt();
    expect(port.invoke).not.toHaveBeenCalled();

    await tools.callTool("snapshot", {}, new AbortController().signal);
    await tools.endPrompt();
    expect(port.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        browserSessionId: "browser_one",
        tool: "close",
        arguments: {},
      }),
    );
    vi.mocked(port.invoke).mockClear();
    await tools.endPrompt();
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("retires its capability for good", async () => {
    const port = ports();
    const tools = new ZerosBrowserTools(port);
    expect(() => tools.assertActive(tools.token)).not.toThrow();
    expect(() => tools.assertActive("other")).toThrow();
    tools.dispose();
    expect(() => tools.assertActive(tools.token)).toThrow();
    expect(tools.listTools()).toEqual([]);
    await expect(
      tools.callTool("snapshot", {}, new AbortController().signal),
    ).rejects.toThrow(/retired/);
  });
});

describe("agent-control admissions", () => {
  const workspace = {
    id: "workspace-1",
    path: "/tmp/zeros-agent-control",
    repoRoot: "/tmp/zeros-agent-control",
    placement: "local",
    archivedAt: null,
  } as Workspace;
  const OPEN = { zerosBrowser: true, computerUse: true, simulators: true, localOrchestration: true };

  beforeEach(() => setAgentControlAvailability(OPEN));
  afterEach(() =>
    setAgentControlAvailability(initialAgentControlAvailability()),
  );

  function input(
    overrides: Partial<AgentSessionToolInput> = {},
  ): AgentSessionToolInput {
    return {
      agentId: "claude",
      executionId: "execution-1",
      cwd: workspace.path,
      workspaceId: workspace.id,
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function browser(route: BrowserRoute = "zeros") {
    return {
      configured: vi.fn(() => true),
      route: vi.fn((): BrowserRoute => route),
      acquire: vi.fn(async () => ({ browserSessionId: "browser_owned" })),
      invoke: vi.fn(async () => OK),
      stop: vi.fn(async () => true),
    };
  }

  it.each([
    ["an unknown agent", { agentId: "droid" }, {}],
    ["a chat without a conversation", { conversationId: undefined }, {}],
    ["a cloud workspace", {}, { placement: "cloud" }],
    ["an archived workspace", {}, { archivedAt: 1 }],
  ] as const)("admits nothing for %s", async (_label, change, row) => {
    const admissions = new AgentControlToolAdmissions({
      resolveWorkspace: () => ({ ...workspace, ...row }) as Workspace,
      browser: browser(),
    });
    await expect(admissions.admit(input(change))).resolves.toBeNull();
  });

  it("admits nothing inside the cloud worker or without the browser host", async () => {
    await expect(
      new AgentControlToolAdmissions({
        cloudWorker: true,
        resolveWorkspace: () => workspace,
        browser: browser(),
      }).admit(input()),
    ).resolves.toBeNull();
    const missing = browser();
    missing.configured.mockReturnValue(false);
    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => workspace,
        browser: missing,
      }).admit(input()),
    ).resolves.toBeNull();
  });

  it("admits no browser, not even Codex's fallback, while the Zeros browser is closed", async () => {
    setAgentControlAvailability({ ...OPEN, zerosBrowser: false });
    for (const [agentId, route] of [
      ["codex", "codex-native"],
      ["claude", "zeros"],
      ["cursor", "zeros"],
    ] as const) {
      await expect(
        new AgentControlToolAdmissions({
          resolveWorkspace: () => workspace,
          browser: browser(route),
        }).admit(input({ agentId })),
      ).resolves.toBeNull();
    }
  });

  it("refuses browser calls once the Zeros browser closes", async () => {
    const host = browser();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: host,
    }).admit(input({ agentId: "cursor" }));
    const [server] = tools!.mcpServers;
    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          {
            requestInit: {
              headers: { Authorization: tools!.env[ZEROS_BROWSER_TOOLS_ENV]! },
            },
          },
        ),
      );
      setAgentControlAvailability({ ...OPEN, zerosBrowser: false });
      await expect(
        client.callTool({ name: "snapshot", arguments: {} }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          { type: "text", text: agentControlUnavailableReason("zerosBrowser") },
        ],
      });
      expect(host.invoke).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
      tools!.revoke();
      await tools!.dispose();
    }
  });

  it("serves zeros_browser over loopback MCP with a scoped capability", async () => {
    const host = browser();
    const admissions = new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: host,
    });
    const tools = await admissions.admit(input({ agentId: "cursor" }));
    expect(tools).not.toBeNull();
    const [server] = tools!.mcpServers;
    expect(server).toMatchObject({
      name: "zeros_browser",
      transport: "http",
      headersFromEnv: { Authorization: ZEROS_BROWSER_TOOLS_ENV },
      toolTimeoutSec: 600,
    });
    const bearer = tools!.env[ZEROS_BROWSER_TOOLS_ENV]!;
    expect(bearer).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(tools!.mcpServers)).not.toContain(
      bearer.slice("Bearer ".length),
    );

    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          { requestInit: { headers: { Authorization: bearer } } },
        ),
      );
      expect((await client.listTools()).tools).toHaveLength(
        BROWSER_TOOL_NAMES.length,
      );
      await expect(
        client.callTool({ name: "snapshot", arguments: {} }),
      ).resolves.toMatchObject({
        content: [{ type: "text" }, { type: "image", mimeType: "image/jpeg" }],
      });
      expect(host.route).toHaveBeenCalledWith(
        "cursor",
        workspace.path,
        workspace.repoRoot,
      );
      expect(host.acquire).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        conversationId: "conversation-1",
        workspaceRoot: workspace.path,
      });
      // The host names the admitted agent on the page's control bar.
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          browserSessionId: "browser_owned",
          tool: "snapshot",
          agent: "cursor",
        }),
      );

      host.route.mockReturnValue("off");
      await expect(
        client.callTool({ name: "snapshot", arguments: {} }),
      ).resolves.toMatchObject({ isError: true });
      expect(host.invoke).toHaveBeenCalledOnce();
    } finally {
      await client.close().catch(() => undefined);
      tools!.revoke();
      await tools!.dispose();
    }
    await expect(
      fetch((server as { url: string }).url, {
        method: "POST",
        headers: { Authorization: bearer },
      }),
    ).rejects.toThrow();
  });
});
