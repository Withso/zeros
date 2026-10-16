import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  agentControlUnavailableReason,
  initialAgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import type { BrowserRoute } from "@zeros/protocol/browser-tools";
import {
  COMPUTER_TOOL_NAMES,
  type ComputerToolResult,
  type ComputerUseRoute,
} from "@zeros/protocol/computer-use-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionToolInput } from "../../agents/session-tools";
import type { Workspace } from "../../git";
import {
  AgentControlToolAdmissions,
  ZEROS_BROWSER_TOOLS_ENV,
  ZEROS_COMPUTER_TOOLS_ENV,
} from "../admission";
import { setAgentControlAvailability } from "../availability";
import {
  ZerosComputerTools,
  zerosComputerToolPolicy,
  type ZerosComputerToolPorts,
} from "../zeros-computer-tools";

const OK: ComputerToolResult = {
  version: 1,
  success: true,
  content: [
    { type: "text", text: "TextEdit window" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ],
};

function ports(overrides: Partial<ZerosComputerToolPorts> = {}) {
  return {
    policy: vi.fn(() => ({ ok: true as const })),
    invoke: vi.fn(async () => OK),
    release: vi.fn(async () => true),
    ...overrides,
  } satisfies ZerosComputerToolPorts;
}

function hanging() {
  return vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<ComputerToolResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
}

describe("zeros_computer routing policy", () => {
  it.each<[string, ComputerUseRoute, boolean, RegExp?]>([
    ["claude", "zeros", true],
    ["cursor", "zeros", true],
    ["codex", "zeros", true],
    ["claude", "off", false, /turned off in Settings > Computer use/],
    ["codex", "off", false, /turned off for Codex/],
    ["codex", "codex-native", false, /built-in computer use/],
  ])("%s with route %s → allowed %s", (family, route, ok, reason) => {
    const policy = zerosComputerToolPolicy(family, route);
    expect(policy.ok).toBe(ok);
    if (!policy.ok) expect(policy.reason).toMatch(reason!);
  });
});

describe("zeros_computer tools", () => {
  it("lists the curated tools only while the agent may use them", () => {
    const port = ports();
    const tools = new ZerosComputerTools(port);
    expect(tools.listTools().map((tool) => tool.name)).toEqual([
      ...COMPUTER_TOOL_NAMES,
    ]);
    vi.mocked(port.policy).mockReturnValue({ ok: false, reason: "off" });
    expect(tools.listTools()).toEqual([]);
  });

  it("runs a validated call in main with this turn's ID", async () => {
    const port = ports();
    const tools = new ZerosComputerTools(port);
    const result = await tools.callTool(
      "screenshot",
      { pid: 42, window_id: 7 },
      new AbortController().signal,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "TextEdit window" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    const request = vi.mocked(port.invoke).mock.calls[0]![0];
    expect(request).toMatchObject({
      tool: "screenshot",
      arguments: { pid: 42, window_id: 7 },
    });
    expect(request.turnId).toMatch(/^turn_[0-9a-f-]{36}$/);
  });

  it("refuses bad arguments and a turned-off route before reaching main", async () => {
    const port = ports();
    const tools = new ZerosComputerTools(port);
    const signal = new AbortController().signal;
    await expect(
      tools.callTool("click", { pid: "42" }, signal),
    ).resolves.toMatchObject({ isError: true });
    await expect(tools.callTool("run_script", {}, signal)).resolves.toMatchObject(
      { isError: true },
    );
    vi.mocked(port.policy).mockReturnValue({
      ok: false,
      reason: "Computer use is turned off in Settings > Computer use.",
    });
    await expect(tools.callTool("list_apps", {}, signal)).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Computer use is turned off in Settings > Computer use.",
        },
      ],
      isError: true,
    });
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("reports a refused or failed action as an MCP error result", async () => {
    const tools = new ZerosComputerTools(
      ports({
        invoke: vi.fn(async () => ({
          version: 1 as const,
          success: false,
          content: [
            {
              type: "text" as const,
              text: "The user did not allow Claude to control Safari.",
            },
          ],
        })),
      }),
    );
    await expect(
      tools.callTool("list_windows", { pid: 42 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "The user did not allow Claude to control Safari." },
      ],
      isError: true,
    });
  });

  it("gives the Mac back at turn end only after a call, and starts a new turn ID", async () => {
    const port = ports();
    const tools = new ZerosComputerTools(port);
    await tools.endPrompt();
    expect(port.release).not.toHaveBeenCalled();

    await tools.callTool("list_apps", {}, new AbortController().signal);
    await tools.endPrompt();
    expect(port.release).toHaveBeenCalledWith("turn-end");
    await tools.endPrompt();
    expect(port.release).toHaveBeenCalledOnce();

    const first = vi.mocked(port.invoke).mock.calls[0]![0].turnId;
    tools.beginPrompt();
    await tools.callTool("list_apps", {}, new AbortController().signal);
    expect(vi.mocked(port.invoke).mock.calls[1]![0].turnId).not.toBe(first);
  });

  it("Stop fails pending calls for the rest of the turn and releases the Mac", async () => {
    const port = ports({ invoke: hanging() });
    const tools = new ZerosComputerTools(port);
    const pending = tools.callTool(
      "click",
      { pid: 42, element_token: "s0a1b2c3d:3" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    tools.cancel();
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "Computer use was stopped." }],
      isError: true,
    });
    expect(port.release).toHaveBeenCalledWith("stop");
    await expect(
      tools.callTool("list_apps", {}, new AbortController().signal),
    ).resolves.toMatchObject({ isError: true });
    expect(port.invoke).toHaveBeenCalledOnce();

    vi.mocked(port.invoke).mockImplementation(async () => OK);
    tools.beginPrompt();
    await expect(
      tools.callTool("list_apps", {}, new AbortController().signal),
    ).resolves.not.toHaveProperty("isError");
  });

  it("aborts the request to main when the provider cancels one call", async () => {
    const port = ports({ invoke: hanging() });
    const tools = new ZerosComputerTools(port);
    const controller = new AbortController();
    const pending = tools.callTool("list_apps", {}, controller.signal);
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    const signal = vi.mocked(port.invoke).mock.calls[0]![0].signal;
    controller.abort();
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "The computer action was cancelled." }],
      isError: true,
    });
    expect(signal.aborted).toBe(true);
  });

  it("retires for good and releases without forgetting approvals", async () => {
    const port = ports();
    const tools = new ZerosComputerTools(port);
    await tools.callTool("list_apps", {}, new AbortController().signal);
    expect(() => tools.assertActive(tools.token)).not.toThrow();
    expect(() => tools.assertActive("other")).toThrow();
    tools.dispose();
    expect(port.release).toHaveBeenCalledWith("turn-end");
    expect(() => tools.assertActive(tools.token)).toThrow();
    expect(tools.listTools()).toEqual([]);
    await expect(
      tools.callTool("list_apps", {}, new AbortController().signal),
    ).rejects.toThrow(/retired/);
  });
});

describe("agent-control admissions with computer use", () => {
  const workspace = {
    id: "workspace-1",
    path: "/tmp/zeros-agent-control",
    repoRoot: "/tmp/zeros-agent-control",
    placement: "local",
    archivedAt: null,
  } as Workspace;
  const OPEN = { zerosBrowser: true, computerUse: true, simulators: true };

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

  function browser(configured = true) {
    return {
      configured: vi.fn(() => configured),
      route: vi.fn((): BrowserRoute => "zeros"),
      acquire: vi.fn(async () => ({ browserSessionId: "browser_owned" })),
      invoke: vi.fn(async () => ({
        version: 1 as const,
        success: true,
        content: [],
      })),
      stop: vi.fn(async () => true),
    };
  }

  function computer(route: ComputerUseRoute = "zeros") {
    return {
      configured: vi.fn(() => true),
      route: vi.fn((): ComputerUseRoute => route),
      invoke: vi.fn(async () => OK),
      release: vi.fn(async () => true),
    };
  }

  it("adds zeros_computer next to zeros_browser only on the Zeros route", async () => {
    const off = new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      computer: computer("off"),
    });
    const browserOnly = await off.admit(input());
    expect(browserOnly!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_browser",
    ]);
    await browserOnly!.dispose();

    const native = new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      computer: computer("codex-native"),
    });
    const codex = await native.admit(input({ agentId: "codex" }));
    expect(codex!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_browser",
    ]);
    await codex!.dispose();

    const both = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      computer: computer(),
    }).admit(input());
    try {
      expect(both!.mcpServers.map((server) => server.name)).toEqual([
        "zeros_browser",
        "zeros_computer",
      ]);
      expect(Object.keys(both!.env).sort()).toEqual(
        [ZEROS_BROWSER_TOOLS_ENV, ZEROS_COMPUTER_TOOLS_ENV].sort(),
      );
      expect(both!.env[ZEROS_BROWSER_TOOLS_ENV]).not.toBe(
        both!.env[ZEROS_COMPUTER_TOOLS_ENV],
      );
    } finally {
      await both!.dispose();
    }
  });

  it("admits computer tools without the browser host, and nothing in the cloud", async () => {
    const host = computer();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      computer: host,
    }).admit(input({ agentId: "cursor" }));
    expect(tools!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_computer",
    ]);
    await tools!.dispose();

    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => ({ ...workspace, placement: "cloud" }) as Workspace,
        browser: browser(false),
        computer: computer(),
      }).admit(input()),
    ).resolves.toBeNull();
    const broken = computer();
    broken.route.mockImplementation(() => {
      throw new Error("settings unreadable");
    });
    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => workspace,
        browser: browser(false),
        computer: broken,
      }).admit(input()),
    ).resolves.toBeNull();
  });

  it("admits no computer tools while computer use is closed, and refuses calls once it closes", async () => {
    setAgentControlAvailability({ ...OPEN, computerUse: false });
    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => workspace,
        browser: browser(false),
        computer: computer(),
      }).admit(input()),
    ).resolves.toBeNull();

    setAgentControlAvailability(OPEN);
    const host = computer();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      computer: host,
    }).admit(input());
    const [server] = tools!.mcpServers;
    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          {
            requestInit: {
              headers: { Authorization: tools!.env[ZEROS_COMPUTER_TOOLS_ENV]! },
            },
          },
        ),
      );
      setAgentControlAvailability({ ...OPEN, computerUse: false });
      tools!.beginPrompt?.();
      await expect(
        client.callTool({ name: "list_apps", arguments: {} }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          { type: "text", text: agentControlUnavailableReason("computerUse") },
        ],
      });
      expect(host.invoke).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
      tools!.revoke();
      await tools!.dispose();
    }
  });

  it("serves zeros_computer over loopback MCP bound to the chat and agent", async () => {
    const host = computer();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      computer: host,
    }).admit(input({ agentId: "cursor" }));
    const [server] = tools!.mcpServers;
    expect(server).toMatchObject({
      name: "zeros_computer",
      transport: "http",
      headersFromEnv: { Authorization: ZEROS_COMPUTER_TOOLS_ENV },
      toolTimeoutSec: 660,
    });
    const bearer = tools!.env[ZEROS_COMPUTER_TOOLS_ENV]!;
    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          { requestInit: { headers: { Authorization: bearer } } },
        ),
      );
      expect((await client.listTools()).tools).toHaveLength(
        COMPUTER_TOOL_NAMES.length,
      );
      tools!.beginPrompt?.();
      await expect(
        client.callTool({ name: "list_apps", arguments: {} }),
      ).resolves.toMatchObject({
        content: [{ type: "text" }, { type: "image", mimeType: "image/png" }],
      });
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: {
            workspaceId: workspace.id,
            conversationId: "conversation-1",
          },
          agent: "cursor",
          tool: "list_apps",
          arguments: {},
          turnId: expect.stringMatching(/^turn_/),
        }),
        expect.any(AbortSignal),
      );
      await tools!.endPrompt?.();
      expect(host.release).toHaveBeenCalledWith(
        { workspaceId: workspace.id, conversationId: "conversation-1" },
        "turn-end",
      );
    } finally {
      await client.close().catch(() => undefined);
      tools!.revoke();
      await tools!.dispose();
    }
  });
});
