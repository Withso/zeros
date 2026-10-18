import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  agentControlUnavailableReason,
  initialAgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import type { BrowserRoute } from "@zeros/protocol/browser-tools";
import type { ComputerUseRoute } from "@zeros/protocol/computer-use-tools";
import {
  DEVICE_TOOL_NAMES,
  type DeviceToolResult,
  type DeviceToolRoute,
} from "@zeros/protocol/device-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionToolInput } from "../../agents/session-tools";
import type { Workspace } from "../../git";
import {
  AgentControlToolAdmissions,
  ZEROS_BROWSER_TOOLS_ENV,
  ZEROS_COMPUTER_TOOLS_ENV,
  ZEROS_DEVICE_TOOLS_ENV,
} from "../admission";
import { setAgentControlAvailability } from "../availability";
import {
  DEVICE_TOOLS_OFF,
  ZerosDeviceTools,
  zerosDeviceToolPolicy,
  type ZerosDeviceToolPorts,
} from "../zeros-device-tools";

const DEVICE_ID = "FBF8387E-2D3A-4C47-9D0B-3E5F2A1B9C8D";
const OK: DeviceToolResult = {
  version: 1,
  success: true,
  content: [
    { type: "text", text: "iPhone 17 (402×874 points)" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ],
};

function ports(overrides: Partial<ZerosDeviceToolPorts> = {}) {
  return {
    policy: vi.fn(() => ({ ok: true as const })),
    invoke: vi.fn(async () => OK),
    release: vi.fn(async () => true),
    ...overrides,
  } satisfies ZerosDeviceToolPorts;
}

function hanging() {
  return vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<DeviceToolResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
}

describe("zeros_device routing policy", () => {
  it("allows the Zeros route and explains where to turn it on otherwise", () => {
    expect(zerosDeviceToolPolicy("zeros")).toEqual({ ok: true });
    expect(zerosDeviceToolPolicy("off")).toEqual({
      ok: false,
      reason: DEVICE_TOOLS_OFF,
    });
    expect(DEVICE_TOOLS_OFF).toMatch(/Settings > Simulators/);
  });
});

describe("zeros_device tools", () => {
  it("lists the curated tools only while the agent may use them", () => {
    const port = ports();
    const tools = new ZerosDeviceTools(port);
    expect(tools.listTools().map((tool) => tool.name)).toEqual([
      ...DEVICE_TOOL_NAMES,
    ]);
    vi.mocked(port.policy).mockReturnValue({ ok: false, reason: "off" });
    expect(tools.listTools()).toEqual([]);
  });

  it("runs a validated call in main with this turn's ID", async () => {
    const port = ports();
    const tools = new ZerosDeviceTools(port);
    const result = await tools.callTool(
      "screenshot",
      { device_id: DEVICE_ID },
      new AbortController().signal,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "iPhone 17 (402×874 points)" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    const request = vi.mocked(port.invoke).mock.calls[0]![0];
    expect(request).toMatchObject({
      tool: "screenshot",
      arguments: { device_id: DEVICE_ID },
    });
    expect(request.turnId).toMatch(/^turn_[0-9a-f-]{36}$/);
  });

  it("refuses bad arguments and a turned-off route before reaching main", async () => {
    const port = ports();
    const tools = new ZerosDeviceTools(port);
    const signal = new AbortController().signal;
    await expect(
      tools.callTool("tap", { device_id: DEVICE_ID }, signal),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      tools.callTool(
        "open_url",
        { device_id: DEVICE_ID, url: "file:///etc/passwd" },
        signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      tools.callTool("erase_device", { device_id: DEVICE_ID }, signal),
    ).resolves.toMatchObject({ isError: true });
    vi.mocked(port.policy).mockReturnValue({ ok: false, reason: DEVICE_TOOLS_OFF });
    await expect(tools.callTool("list_devices", {}, signal)).resolves.toEqual({
      content: [{ type: "text", text: DEVICE_TOOLS_OFF }],
      isError: true,
    });
    expect(port.invoke).not.toHaveBeenCalled();
  });

  it("reports unreadable settings as a refusal, not a crash", async () => {
    const tools = new ZerosDeviceTools(
      ports({
        policy: vi.fn(() => {
          throw new Error("settings.toml is malformed at /Users/me/.zeros");
        }),
      }),
    );
    expect(tools.listTools()).toEqual([]);
    await expect(
      tools.callTool("list_devices", {}, new AbortController().signal),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Simulator settings could not be read. Check Settings > Simulators.",
        },
      ],
      isError: true,
    });
  });

  it("reports a refused or failed action as an MCP error result", async () => {
    const tools = new ZerosDeviceTools(
      ports({
        invoke: vi.fn(async () => ({
          version: 1 as const,
          success: false,
          content: [
            {
              type: "text" as const,
              text: "The user did not allow Claude to use iPhone 17.",
            },
          ],
        })),
      }),
    );
    await expect(
      tools.callTool(
        "launch_app",
        { device_id: DEVICE_ID, bundle_id: "com.apple.mobilesafari" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "The user did not allow Claude to use iPhone 17." },
      ],
      isError: true,
    });
  });

  it("lets go of the simulators at turn end only after a call, with a new turn ID next time", async () => {
    const port = ports();
    const tools = new ZerosDeviceTools(port);
    await tools.endPrompt();
    expect(port.release).not.toHaveBeenCalled();

    await tools.callTool("list_devices", {}, new AbortController().signal);
    await tools.endPrompt();
    expect(port.release).toHaveBeenCalledWith("turn-end");
    await tools.endPrompt();
    expect(port.release).toHaveBeenCalledOnce();

    const first = vi.mocked(port.invoke).mock.calls[0]![0].turnId;
    tools.beginPrompt();
    await tools.callTool("list_devices", {}, new AbortController().signal);
    expect(vi.mocked(port.invoke).mock.calls[1]![0].turnId).not.toBe(first);
  });

  it("Stop fails pending calls for the rest of the turn and lets go", async () => {
    const port = ports({ invoke: hanging() });
    const tools = new ZerosDeviceTools(port);
    const pending = tools.callTool(
      "boot_device",
      { device_id: DEVICE_ID },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    tools.cancel();
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "Simulator use was stopped." }],
      isError: true,
    });
    expect(port.release).toHaveBeenCalledWith("stop");
    await expect(
      tools.callTool("list_devices", {}, new AbortController().signal),
    ).resolves.toMatchObject({ isError: true });
    expect(port.invoke).toHaveBeenCalledOnce();

    vi.mocked(port.invoke).mockImplementation(async () => OK);
    tools.beginPrompt();
    await expect(
      tools.callTool("list_devices", {}, new AbortController().signal),
    ).resolves.not.toHaveProperty("isError");
  });

  it("aborts the request to main when the provider cancels one call", async () => {
    const port = ports({ invoke: hanging() });
    const tools = new ZerosDeviceTools(port);
    const controller = new AbortController();
    const pending = tools.callTool("list_devices", {}, controller.signal);
    await vi.waitFor(() => expect(port.invoke).toHaveBeenCalledOnce());
    const signal = vi.mocked(port.invoke).mock.calls[0]![0].signal;
    controller.abort();
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "The simulator action was cancelled." }],
      isError: true,
    });
    expect(signal.aborted).toBe(true);
  });

  it("retires for good and lets go without forgetting approvals", async () => {
    const port = ports();
    const tools = new ZerosDeviceTools(port);
    await tools.callTool("list_devices", {}, new AbortController().signal);
    expect(() => tools.assertActive(tools.token)).not.toThrow();
    expect(() => tools.assertActive("other")).toThrow();
    tools.dispose();
    expect(port.release).toHaveBeenCalledWith("turn-end");
    expect(() => tools.assertActive(tools.token)).toThrow();
    expect(tools.listTools()).toEqual([]);
    await expect(
      tools.callTool("list_devices", {}, new AbortController().signal),
    ).rejects.toThrow(/retired/);
  });
});

describe("agent-control admissions with simulators", () => {
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
      invoke: vi.fn(async () => ({
        version: 1 as const,
        success: true,
        content: [],
      })),
      release: vi.fn(async () => true),
    };
  }

  function device(route: DeviceToolRoute = "zeros", configured = true) {
    return {
      configured: vi.fn(() => configured),
      route: vi.fn((): DeviceToolRoute => route),
      invoke: vi.fn(async () => OK),
      release: vi.fn(async () => true),
    };
  }

  it("adds zeros_device next to the other control tools only on the Zeros route", async () => {
    const off = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      computer: computer(),
      device: device("off"),
    }).admit(input());
    expect(off!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_browser",
      "zeros_computer",
    ]);
    await off!.dispose();

    const unconfigured = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      device: device("zeros", false),
    }).admit(input());
    expect(unconfigured!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_browser",
    ]);
    await unconfigured!.dispose();

    const all = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(),
      computer: computer(),
      device: device(),
    }).admit(input({ agentId: "codex" }));
    try {
      expect(all!.mcpServers.map((server) => server.name)).toEqual([
        "zeros_browser",
        "zeros_computer",
        "zeros_device",
      ]);
      expect(Object.keys(all!.env).sort()).toEqual(
        [
          ZEROS_BROWSER_TOOLS_ENV,
          ZEROS_COMPUTER_TOOLS_ENV,
          ZEROS_DEVICE_TOOLS_ENV,
        ].sort(),
      );
      expect(new Set(Object.values(all!.env)).size).toBe(3);
    } finally {
      await all!.dispose();
    }
  });

  it("admits simulator tools alone, and nothing in the cloud or with unreadable settings", async () => {
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      device: device(),
    }).admit(input({ agentId: "cursor" }));
    expect(tools!.mcpServers.map((server) => server.name)).toEqual([
      "zeros_device",
    ]);
    await tools!.dispose();

    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => ({ ...workspace, placement: "cloud" }) as Workspace,
        browser: browser(false),
        device: device(),
      }).admit(input()),
    ).resolves.toBeNull();
    await expect(
      new AgentControlToolAdmissions({
        cloudWorker: true,
        resolveWorkspace: () => workspace,
        browser: browser(false),
        device: device(),
      }).admit(input()),
    ).resolves.toBeNull();
    const broken = device();
    broken.route.mockImplementation(() => {
      throw new Error("settings unreadable");
    });
    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => workspace,
        browser: browser(false),
        device: broken,
      }).admit(input()),
    ).resolves.toBeNull();
  });

  it("admits no simulator tools while simulators are closed, and refuses calls once they close", async () => {
    setAgentControlAvailability({ ...OPEN, simulators: false });
    await expect(
      new AgentControlToolAdmissions({
        resolveWorkspace: () => workspace,
        browser: browser(false),
        device: device(),
      }).admit(input()),
    ).resolves.toBeNull();

    setAgentControlAvailability(OPEN);
    const host = device();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      device: host,
    }).admit(input());
    const [server] = tools!.mcpServers;
    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          {
            requestInit: {
              headers: { Authorization: tools!.env[ZEROS_DEVICE_TOOLS_ENV]! },
            },
          },
        ),
      );
      setAgentControlAvailability({ ...OPEN, simulators: false });
      tools!.beginPrompt?.();
      await expect(
        client.callTool({
          name: "screenshot",
          arguments: { device_id: DEVICE_ID },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          { type: "text", text: agentControlUnavailableReason("simulators") },
        ],
      });
      expect(host.invoke).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
      tools!.revoke();
      await tools!.dispose();
    }
  });

  it("serves zeros_device over loopback MCP bound to the chat and agent", async () => {
    const host = device();
    const tools = await new AgentControlToolAdmissions({
      resolveWorkspace: () => workspace,
      browser: browser(false),
      device: host,
    }).admit(input({ agentId: "codex" }));
    const [server] = tools!.mcpServers;
    expect(server).toMatchObject({
      name: "zeros_device",
      transport: "http",
      headersFromEnv: { Authorization: ZEROS_DEVICE_TOOLS_ENV },
      toolTimeoutSec: 660,
    });
    const bearer = tools!.env[ZEROS_DEVICE_TOOLS_ENV]!;
    const client = new Client({ name: "agent-control-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL((server as { url: string }).url),
          { requestInit: { headers: { Authorization: bearer } } },
        ),
      );
      expect((await client.listTools()).tools).toHaveLength(
        DEVICE_TOOL_NAMES.length,
      );
      tools!.beginPrompt?.();
      await expect(
        client.callTool({
          name: "screenshot",
          arguments: { device_id: DEVICE_ID },
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text" }, { type: "image", mimeType: "image/png" }],
      });
      expect(host.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: {
            workspaceId: workspace.id,
            conversationId: "conversation-1",
          },
          agent: "codex",
          tool: "screenshot",
          arguments: { device_id: DEVICE_ID },
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
