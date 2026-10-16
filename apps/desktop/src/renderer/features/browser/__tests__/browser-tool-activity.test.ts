import { describe, expect, it } from "vitest";

import type {
  AgentMessage,
  AgentToolMessage,
} from "../../agent/use-agent-session";
import {
  browserActivityGroupLabel,
  browserActivityGroupStatus,
  browserActivityUsesWebsiteIcon,
  browserActivityTailClosed,
  browserToolActivity,
  groupBrowserToolActivity,
  isCodexNodeReplJsToolCall,
  partitionBrowserActivityForSummary,
  resolveBrowserActionUrls,
  resolveBrowserActivityPresentation,
} from "../browser-tool-activity";

function mcpTool(
  id: string,
  title: string,
  rawInput: Record<string, unknown>,
): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    title,
    toolKind: "mcp",
    status: "completed",
    rawInput,
    createdAt: 1,
    updatedAt: 2,
  };
}

function nativeCua(
  id: string,
  title: string,
  surface: unknown,
  code: string,
  status: AgentToolMessage["status"] = "completed",
): AgentToolMessage {
  return {
    ...mcpTool(id, "cua_repl:js", {
      server: "cua_repl",
      tool: "js",
      arguments: { title, code },
    }),
    status,
    ...(surface ? { rawOutput: { _meta: { "codex/toolSurface": surface } } } : {}),
  };
}

function tool(
  id: string,
  input: Record<string, unknown>,
  status: AgentToolMessage["status"] = "completed",
): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    title: `zeros_browser/${String(input.tool ?? "tool")}`,
    toolKind: "other",
    status,
    rawInput: { namespace: "zeros_browser", ...input },
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("compact browser transcript activity", () => {
  it("uses website artwork only for page interaction rows", () => {
    expect(browserActivityUsesWebsiteIcon({ phase: "connect" })).toBe(false);
    expect(browserActivityUsesWebsiteIcon({ phase: "browse" })).toBe(true);
    expect(browserActivityUsesWebsiteIcon({ phase: "handoff" })).toBe(false);
  });

  it("closes the Browser tail only at a later visible event or turn settlement", () => {
    expect(browserActivityTailClosed(true, false)).toBe(false);
    expect(browserActivityTailClosed(true, true)).toBe(true);
    expect(browserActivityTailClosed(false, false)).toBe(true);
  });

  it("keeps the tail group browsing until a later event closes it", () => {
    expect(
      browserActivityGroupStatus(
        [
          tool("done", { tool: "open" }, "completed"),
          tool("live", { tool: "snapshot" }, "in_progress"),
        ],
        true,
      ),
    ).toBe("browsing");
    expect(
      browserActivityGroupStatus(
        [
          tool("failed", { tool: "open" }, "failed"),
          tool("recovered", { tool: "snapshot" }, "completed"),
        ],
        false,
      ),
    ).toBe("browsing");
    expect(
      browserActivityGroupStatus(
        [
          tool("failed", { tool: "open" }, "failed"),
          tool("recovered", { tool: "snapshot" }, "completed"),
        ],
        true,
      ),
    ).toBe("used");
    expect(
      browserActivityGroupStatus(
        [
          tool("failed-a", { tool: "open" }, "failed"),
          tool("failed-b", { tool: "snapshot" }, "failed"),
        ],
        true,
      ),
    ).toBe("failed");
  });

  it("recognizes official Codex node_repl Browser batches and preserves their titles", () => {
    expect(
      browserToolActivity({
        id: "native",
        kind: "tool",
        toolCallId: "native",
        toolKind: "mcp",
        title: "node_repl:js",
        status: "in_progress",
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: {
            title: "Open the M5 feature",
            code: "await tab.goto('https://www.apple.com/macbook-air/')",
          },
        },
        content: [],
        createdAt: 1,
        updatedAt: 1,
      } as AgentToolMessage),
    ).toMatchObject({
      label: "Open the M5 feature",
      phase: "browse",
      target: "www.apple.com",
    });

    expect(
      browserToolActivity({
        id: "native-result-url",
        kind: "tool",
        toolCallId: "native-result-url",
        toolKind: "mcp",
        title: "node_repl:js",
        status: "completed",
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: { title: "Inspect dashboard", code: "await tab.url();" },
        },
        rawOutput: {
          raw: {
            _meta: {
              browser_use: { url: "https://example.com/dashboard" },
              "codex/browserUse": true,
            },
          },
        },
        createdAt: 1,
        updatedAt: 1,
      } as AgentToolMessage),
    ).toMatchObject({
      label: "Inspect dashboard",
      phase: "browse",
      target: "example.com",
      url: "https://example.com/dashboard",
    });
  });

  it("classifies native Browser connection and handoff rows for the pointer icon", () => {
    const native = (id: string, title: string, code: string) =>
      browserToolActivity({
        id,
        kind: "tool",
        toolCallId: id,
        toolKind: "mcp",
        title: "node_repl:js",
        status: "completed",
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: { title, code },
        },
        content: [],
        createdAt: 1,
        updatedAt: 1,
      } as AgentToolMessage);

    expect(
      native(
        "connect",
        "Connect to the in-app browser",
        "globalThis.agent = await setupBrowserRuntime(); await agent.browsers.get('iab');",
      ),
    ).toMatchObject({
      label: "Connect to the in-app browser",
      phase: "connect",
    });
    expect(
      native(
        "claim",
        "Claim the existing browser tab",
        "const tabs = await iab.openTabs(); const tab = await iab.claimTab(tabs[0]);",
      ),
    ).toMatchObject({
      label: "Claim the existing browser tab",
      phase: "connect",
    });
    expect(
      native(
        "leave",
        "Leave AirPods open",
        "await iab.tabs.finalize({keep:[{tab,status:'deliverable'}]});",
      ),
    ).toMatchObject({ label: "Leave AirPods open", phase: "handoff" });
  });

  it("recognizes the official global setup batch as a connection row", () => {
    expect(
      browserToolActivity({
        id: "connect-globals",
        kind: "tool",
        toolCallId: "connect-globals",
        toolKind: "mcp",
        title: "node_repl:js",
        status: "completed",
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: {
            title: "Connect to the in-app browser",
            code: "globalThis.agent = await setupBrowserRuntime(); globalThis.iab = await agent.browsers.get('iab');",
          },
        },
        content: [],
        createdAt: 1,
        updatedAt: 1,
      } as AgentToolMessage),
    ).toMatchObject({
      phase: "connect",
      label: "Connect to the in-app browser",
    });
  });

  it("recognizes Codex dynamic tools and legacy MCP-shaped names", () => {
    expect(
      browserToolActivity(
        tool("a", {
          tool: "open",
          arguments: { url: "https://example.com/docs" },
        }),
      ),
    ).toMatchObject({ tool: "open", label: "Opened", target: "example.com" });

    expect(
      browserToolActivity({
        ...tool("b", {}),
        title: "zeros_browser/snapshot",
        rawInput: {},
      }),
    ).toMatchObject({ tool: "snapshot", label: "Read page" });

    expect(
      browserToolActivity({
        ...tool("claude", {}),
        title: "mcp__zeros_browser__open",
        rawInput: { url: "https://docs.example.net/start" },
      }),
    ).toMatchObject({
      tool: "open",
      label: "Opened",
      target: "docs.example.net",
    });
  });

  it("recognizes zeros_browser calls in each provider's native MCP envelope", () => {
    expect(
      browserToolActivity(
        mcpTool("codex", "zeros_browser:open", {
          server: "zeros_browser",
          tool: "open",
          arguments: { url: "https://example.com/docs" },
        }),
      ),
    ).toMatchObject({ tool: "open", label: "Opened", target: "example.com" });
    expect(
      browserToolActivity(
        mcpTool("claude", "mcp__zeros_browser__click", {
          ref: "b3_0123456789abcdef01234567",
        }),
      ),
    ).toMatchObject({ tool: "click", label: "Clicked", target: "b3" });
    expect(
      browserToolActivity(
        mcpTool("cursor", "mcp", {
          providerIdentifier: "zeros_browser",
          toolName: "open",
          args: { url: "https://docs.example.net/start" },
        }),
      ),
    ).toMatchObject({
      tool: "open",
      label: "Opened",
      target: "docs.example.net",
    });
    expect(
      browserToolActivity(
        mcpTool("cursor-child", "MCP snapshot", {
          providerIdentifier: "zeros_browser",
          toolName: "snapshot",
          args: {},
        }),
      ),
    ).toMatchObject({ tool: "snapshot", label: "Read page" });
    expect(
      browserToolActivity(
        mcpTool("cursor-qualified", "MCP mcp__zeros_browser__back", {
          toolName: "mcp__zeros_browser__back",
        }),
      ),
    ).toMatchObject({ tool: "back", label: "Went back" });
  });

  it("lets explicit foreign MCP identity win over a zeros_browser-looking name", () => {
    expect(
      browserToolActivity(
        mcpTool("codex-foreign", "mcp__zeros_browser__open", {
          server: "another-browser",
          tool: "open",
          arguments: { url: "https://example.com" },
        }),
      ),
    ).toBeNull();
    expect(
      browserToolActivity(
        mcpTool("cursor-foreign", "MCP mcp__zeros_browser__open", {
          providerIdentifier: "another-browser",
          toolName: "open",
          args: { url: "https://example.com" },
        }),
      ),
    ).toBeNull();
    expect(
      browserToolActivity(
        mcpTool("cursor-unknown", "mcp", {
          providerIdentifier: "zeros_browser",
          toolName: "evaluate",
          args: {},
        }),
      ),
    ).toBeNull();
  });

  it("groups a Cursor zeros_browser burst into one Browser activity", () => {
    const grouped = groupBrowserToolActivity([
      mcpTool("cursor-open", "mcp", {
        providerIdentifier: "zeros_browser",
        toolName: "open",
        args: { url: "https://example.com" },
      }),
      mcpTool("cursor-read", "mcp", {
        providerIdentifier: "zeros_browser",
        toolName: "snapshot",
        args: {},
      }),
    ]);
    expect(grouped).toMatchObject([
      {
        kind: "browser-activity",
        surface: "browser",
        actions: [{ tool: "open" }, { tool: "snapshot" }],
      },
    ]);
  });

  it("groups Codex computer-use calls into their own activity instead of dropping them", () => {
    const textEdit = {
      kind: "computerUse",
      app: { kind: "appId", appId: "com.apple.TextEdit" },
    };
    const calculator = {
      kind: "computerUse",
      app: { kind: "appId", appId: "com.apple.Calculator" },
    };
    const events: AgentMessage[] = [
      nativeCua(
        "browse",
        "Open the docs",
        null,
        "await tab.goto('https://example.com/docs')",
      ),
      nativeCua("type", "Type the note", textEdit, "await textEdit.type('hi')"),
      nativeCua(
        "read",
        "Read the total",
        calculator,
        "await calculator.getAXState()",
      ),
      nativeCua(
        "save",
        "Save the note",
        null,
        "await textEdit.press('cmd+s')",
        "in_progress",
      ),
      {
        ...mcpTool("legacy", "computer-use:click", {
          server: "computer-use",
          tool: "click",
          arguments: { x: 4, y: 8 },
        }),
        status: "in_progress",
      },
    ];
    const grouped = groupBrowserToolActivity(events);
    expect(grouped).toMatchObject([
      {
        kind: "browser-activity",
        surface: "browser",
        closed: true,
        actions: [{ label: "Open the docs" }],
      },
      {
        kind: "browser-activity",
        surface: "computer",
        closed: false,
        actions: [
          {
            label: "Type the note",
            surface: "computer",
            appId: "com.apple.TextEdit",
            external: true,
          },
          { label: "Read the total", appId: "com.apple.Calculator" },
          { label: "Save the note", status: "in_progress" },
          { label: "Use computer", status: "in_progress" },
        ],
      },
    ]);
    const computer = grouped[1];
    if (computer?.kind !== "browser-activity") {
      throw new Error("Expected a computer activity group.");
    }
    expect(computer.actions.some(browserActivityUsesWebsiteIcon)).toBe(false);
    expect(browserToolActivity(events[1]!)).toBeNull();
    expect(partitionBrowserActivityForSummary(events)).toMatchObject({
      browserEvents: [{ id: "browse" }],
      otherEvents: [
        { id: "type" },
        { id: "read" },
        { id: "save" },
        { id: "legacy" },
      ],
    });
  });

  it("labels each activity group by what the agent controlled", () => {
    expect(browserActivityGroupLabel("browser", "browsing")).toBe("Browsing");
    expect(browserActivityGroupLabel("browser", "used")).toBe(
      "Used the browser",
    );
    expect(browserActivityGroupLabel("browser", "failed")).toBe(
      "Browser use failed",
    );
    expect(browserActivityGroupLabel("computer", "browsing")).toBe(
      "Using the computer",
    );
    expect(browserActivityGroupLabel("computer", "used")).toBe(
      "Used the computer",
    );
    expect(browserActivityGroupLabel("computer", "failed")).toBe(
      "Computer use failed",
    );
  });

  it("labels Zeros computer use the same way for every provider family", () => {
    // Codex: server (or namespace) plus tool.
    expect(
      browserToolActivity(
        mcpTool("codex-open", "zeros_computer/open_app", {
          server: "zeros_computer",
          tool: "open_app",
          arguments: { bundle_id: "com.apple.TextEdit" },
        }),
      ),
    ).toMatchObject({
      surface: "computer",
      tool: "open",
      label: "Opened app",
      target: "com.apple.TextEdit",
      appId: "com.apple.TextEdit",
      external: true,
    });
    // Claude: the qualified MCP title, with the arguments as rawInput.
    expect(
      browserToolActivity(
        mcpTool("claude-type", "mcp__zeros_computer__type_text", {
          pid: 42,
          text: "hello",
        }),
      ),
    ).toMatchObject({ surface: "computer", tool: "type", label: "Typed" });
    // Cursor: providerIdentifier plus toolName.
    expect(
      browserToolActivity(
        mcpTool("cursor-shot", "mcp", {
          providerIdentifier: "zeros_computer",
          toolName: "screenshot",
          args: { pid: 42, window_id: 7 },
        }),
      ),
    ).toMatchObject({
      surface: "computer",
      tool: "screenshot",
      label: "Captured screenshot",
    });
    // A foreign server with a computer-looking title stays out.
    expect(
      browserToolActivity(
        mcpTool("foreign", "mcp__zeros_computer__click", {
          server: "another-computer",
          tool: "click",
          arguments: {},
        }),
      ),
    ).toBeNull();
    // Unknown zeros_computer tool names stay out.
    expect(
      browserToolActivity(
        mcpTool("unknown", "mcp__zeros_computer__explode", { pid: 1 }),
      ),
    ).toBeNull();
  });

  it("groups a Zeros computer-use burst into its own computer activity", () => {
    const grouped = groupBrowserToolActivity([
      tool("browse", { tool: "open", url: "https://example.com" }),
      mcpTool("open-app", "mcp__zeros_computer__open_app", {
        bundle_id: "com.apple.TextEdit",
      }),
      mcpTool("press", "mcp__zeros_computer__press_key", {
        pid: 42,
        key: "return",
      }),
    ]);
    expect(grouped).toMatchObject([
      {
        kind: "browser-activity",
        surface: "browser",
        closed: true,
        actions: [{ tool: "open" }],
      },
      {
        kind: "browser-activity",
        surface: "computer",
        closed: false,
        actions: [
          { label: "Opened app", appId: "com.apple.TextEdit" },
          { label: "Pressed key", tool: "key" },
        ],
      },
    ]);
  });

  it("shows authored computer failure sentences and hides raw driver errors", () => {
    const failedClick = (id: string, text: string): AgentToolMessage => ({
      ...mcpTool(id, "mcp__zeros_computer__click", { pid: 42 }),
      status: "failed",
      rawOutput: [{ type: "text", text }],
    });
    for (const [id, text] of [
      ["blocked", "Safari is blocked in Settings > Computer use."],
      ["off", "Computer use is turned off in Settings > Computer use."],
      ["denied", "The user did not allow Codex to control Safari."],
      [
        "permission",
        "Zeros needs Accessibility access to use your Mac. The user can turn it on in Settings > Computer use.",
      ],
    ] as const) {
      expect(browserToolActivity(failedClick(id, text))).toMatchObject({
        surface: "computer",
        detail: text,
      });
    }
    expect(
      browserToolActivity(
        failedClick(
          "raw",
          "Error: connect ECONNREFUSED /private/var/run/driver.sock",
        ),
      ),
    ).toMatchObject({ detail: "Computer action failed." });
    // A successful call carries no failure detail.
    expect(
      browserToolActivity(mcpTool("ok", "mcp__zeros_computer__click", { pid: 42 }))
        ?.detail,
    ).toBeUndefined();
  });

  it("labels Zeros simulator use the same way for every provider family", () => {
    const device = "8F2A9C4E-1B3D-4E5F-8A7B-0C1D2E3F4A5B";
    // Codex: server (or namespace) plus tool.
    expect(
      browserToolActivity(
        mcpTool("codex-tap", "zeros_device/tap", {
          server: "zeros_device",
          tool: "tap",
          arguments: { device_id: device, ref: "@e3" },
        }),
      ),
    ).toMatchObject({
      surface: "simulator",
      tool: "click",
      label: "Tapped",
      phase: "browse",
      surfaceScope: "simulator",
      external: true,
    });
    // Claude: the qualified MCP title, with the arguments as rawInput. An iOS
    // bundle ID is the row's target but never a Mac app icon.
    const launch = browserToolActivity(
      mcpTool("claude-launch", "mcp__zeros_device__launch_app", {
        device_id: device,
        bundle_id: "com.apple.mobilesafari",
      }),
    );
    expect(launch).toMatchObject({
      surface: "simulator",
      tool: "open",
      label: "Opened app",
      target: "com.apple.mobilesafari",
    });
    expect(launch?.appId).toBeUndefined();
    // Cursor: providerIdentifier plus toolName.
    expect(
      browserToolActivity(
        mcpTool("cursor-shot", "mcp", {
          providerIdentifier: "zeros_device",
          toolName: "screenshot",
          args: { device_id: device },
        }),
      ),
    ).toMatchObject({
      surface: "simulator",
      tool: "screenshot",
      label: "Captured screenshot",
    });
    // A foreign server with a simulator-looking title stays out.
    expect(
      browserToolActivity(
        mcpTool("foreign", "mcp__zeros_device__tap", {
          server: "another-device",
          tool: "tap",
          arguments: {},
        }),
      ),
    ).toBeNull();
    // Unknown zeros_device tool names stay out.
    expect(
      browserToolActivity(
        mcpTool("unknown", "mcp__zeros_device__explode", { device_id: device }),
      ),
    ).toBeNull();
  });

  it("describes simulator gestures by what they did", () => {
    const device = "8F2A9C4E-1B3D-4E5F-8A7B-0C1D2E3F4A5B";
    const label = (tool: string, args: Record<string, unknown>) =>
      browserToolActivity(
        mcpTool(tool, `mcp__zeros_device__${tool}`, {
          device_id: device,
          ...args,
        }),
      )?.label;
    expect(label("tap", { x: 10, y: 20, count: 2 })).toBe("Double-tapped");
    expect(label("tap", { ref: "@e1", hold_ms: 800 })).toBe("Long-pressed");
    expect(label("pinch", { scale: 2 })).toBe("Zoomed in");
    expect(label("pinch", { scale: 0.5 })).toBe("Zoomed out");
    expect(label("scroll", { direction: "down" })).toBe("Scrolled down");
    expect(label("scroll", { direction: "sideways" })).toBe("Scrolled");
    expect(label("rotate", { orientation: "landscape-left" })).toBe(
      "Rotated to landscape",
    );
    expect(label("rotate", { orientation: "portrait" })).toBe(
      "Rotated to portrait",
    );
    expect(label("set_appearance", { appearance: "dark" })).toBe(
      "Switched to dark appearance",
    );
    expect(label("press_button", { button: "home" })).toBe(
      "Pressed the Home button",
    );
    expect(label("press_button", { button: "lock" })).toBe(
      "Pressed the side button",
    );
    expect(label("open_url", { url: "https://example.com/a" })).toBe(
      "Opened link",
    );
    expect(label("boot_device", {})).toBe("Started simulator");
    expect(label("list_devices", {})).toBe("Listed simulators");
  });

  it("groups a Zeros simulator burst into its own simulator activity", () => {
    const device = "8F2A9C4E-1B3D-4E5F-8A7B-0C1D2E3F4A5B";
    const events = [
      tool("browse", { tool: "open", url: "https://example.com" }),
      mcpTool("snapshot", "mcp__zeros_device__snapshot", { device_id: device }),
      mcpTool("tap", "mcp__zeros_device__tap", {
        device_id: device,
        ref: "@e2",
      }),
      mcpTool("open-app", "mcp__zeros_computer__open_app", {
        bundle_id: "com.apple.TextEdit",
      }),
    ];
    const grouped = groupBrowserToolActivity(events);
    expect(grouped).toMatchObject([
      { kind: "browser-activity", surface: "browser", closed: true },
      {
        kind: "browser-activity",
        surface: "simulator",
        closed: true,
        actions: [{ label: "Read screen" }, { label: "Tapped" }],
      },
      { kind: "browser-activity", surface: "computer", closed: false },
    ]);
    const simulator = grouped[1];
    if (simulator?.kind !== "browser-activity") {
      throw new Error("Expected a simulator activity group.");
    }
    expect(simulator.actions.some(browserActivityUsesWebsiteIcon)).toBe(false);
    expect(browserActivityGroupLabel("simulator", "browsing")).toBe(
      "Using the simulator",
    );
    expect(browserActivityGroupLabel("simulator", "used")).toBe(
      "Used the simulator",
    );
    expect(browserActivityGroupLabel("simulator", "failed")).toBe(
      "Simulator use failed",
    );
    // The summary keeps browser favicons for browser work only.
    expect(partitionBrowserActivityForSummary(events)).toMatchObject({
      browserEvents: [{ id: "browse" }],
      otherEvents: [{ id: "snapshot" }, { id: "tap" }, { id: "open-app" }],
    });
  });

  it("recognizes only Claude's official Chrome MCP tools as browser activity", () => {
    const claudeChromeTool = (
      id: string,
      title: string,
      rawInput: Record<string, unknown>,
    ): AgentToolMessage => ({
      id,
      kind: "tool",
      toolCallId: id,
      title,
      toolKind: "mcp",
      status: "completed",
      rawInput,
      createdAt: 1,
      updatedAt: 2,
    });

    expect(
      browserToolActivity(
        claudeChromeTool("claude-open", "mcp__claude-in-chrome__navigate", {
          url: "https://example.com/private?token=secret",
        }),
      ),
    ).toMatchObject({
      tool: "open",
      label: "Opened",
      phase: "browse",
      target: "example.com",
      url: "https://example.com/private?token=secret",
    });
    expect(
      browserToolActivity(
        claudeChromeTool("claude-click", "mcp__claude-in-chrome__computer", {
          action: "left_click",
          text: "private password",
        }),
      ),
    ).toMatchObject({ tool: "click", label: "Clicked", phase: "browse" });
    expect(
      JSON.stringify(
        browserToolActivity(
          claudeChromeTool("claude-type", "mcp__claude-in-chrome__computer", {
            action: "type",
            text: "private password",
          }),
        ),
      ),
    ).not.toContain("private password");
    expect(
      browserToolActivity(
        claudeChromeTool("other-mcp", "mcp__another-browser__navigate", {
          url: "https://example.com",
        }),
      ),
    ).toBeNull();
  });

  it("maps Claude in Chrome connection, read, upload, and close tools", () => {
    const activity = (title: string, rawInput: Record<string, unknown> = {}) =>
      browserToolActivity({
        id: title,
        kind: "tool",
        toolCallId: title,
        title,
        toolKind: "mcp",
        status: "completed",
        rawInput,
        createdAt: 1,
        updatedAt: 2,
      } as AgentToolMessage);

    expect(activity("mcp__claude-in-chrome__tabs_context_mcp")).toMatchObject({
      tool: "snapshot",
      phase: "connect",
      label: "Connected to Chrome",
    });
    expect(activity("mcp__claude-in-chrome__read_page")).toMatchObject({
      tool: "snapshot",
      label: "Read page",
    });
    expect(activity("mcp__claude-in-chrome__upload_image")).toMatchObject({
      tool: "upload",
      label: "Uploaded file",
    });
    expect(activity("mcp__claude-in-chrome__tabs_close_mcp")).toMatchObject({
      tool: "close",
      phase: "handoff",
      label: "Closed tab",
    });
  });

  it("ignores legacy tool messages that do not carry a title", () => {
    const message = {
      ...tool("titleless", {}),
      title: undefined,
      rawInput: {},
    } as unknown as AgentToolMessage;
    expect(browserToolActivity(message)).toBeNull();
  });

  it("groups a primitive call burst into one bounded browser activity unit", () => {
    const events: AgentMessage[] = [
      tool("open", {
        tool: "open",
        arguments: { url: "https://example.com" },
      }),
      tool("snapshot-1", { tool: "snapshot", arguments: {} }),
      tool("click", { tool: "click", arguments: { ref: "b3" } }),
      tool("snapshot-2", { tool: "snapshot", arguments: {} }),
    ];
    const grouped = groupBrowserToolActivity(events);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      kind: "browser-activity",
      id: "browser-activity-open",
    });
    expect(
      grouped[0]?.kind === "browser-activity" && grouped[0].actions,
    ).toHaveLength(4);
  });

  it("keeps native node_repl helper batches inside an active Browser group", () => {
    const native = (
      id: string,
      title: string,
      code: string,
      status: AgentToolMessage["status"] = "completed",
    ): AgentToolMessage =>
      ({
        id,
        kind: "tool",
        toolCallId: id,
        toolKind: "mcp",
        title: "node_repl:js",
        status,
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: { title, code },
        },
        content: [],
        createdAt: 1,
        updatedAt: 1,
      }) as AgentToolMessage;
    const grouped = groupBrowserToolActivity(
      [
        native(
          "visit",
          "Visit public Paper pages",
          "await paperTab.goto('https://paper.design/docs')",
          "failed",
        ),
        native("review", "Review visited pages", "nodeRepl.write(pageVisits)"),
        native(
          "continue",
          "Continue public Paper walkthrough",
          "await paperTab.goto('https://paper.design/community')",
        ),
      ],
      { closeTail: true },
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      kind: "browser-activity",
      closed: true,
      actions: [
        { label: "Visit public Paper pages", status: "failed" },
        { label: "Review visited pages", status: "completed" },
        { label: "Continue public Paper walkthrough", status: "completed" },
      ],
    });
    expect(
      grouped[0]?.kind === "browser-activity" &&
        browserActivityGroupStatus(grouped[0].events, grouped[0].closed),
    ).toBe("used");
    expect(
      grouped[0]?.kind === "browser-activity" &&
        isCodexNodeReplJsToolCall(grouped[0].events[1]!),
    ).toBe(true);
    expect(
      grouped[0]?.kind === "browser-activity" &&
        browserToolActivity(grouped[0].events[1]!),
    ).toBeNull();
    const browserGroup = grouped[0];
    expect(browserGroup?.kind).toBe("browser-activity");
    if (browserGroup?.kind !== "browser-activity") {
      throw new Error("Expected a Browser activity group.");
    }
    expect(
      partitionBrowserActivityForSummary(browserGroup.events),
    ).toMatchObject({
      actions: [
        { label: "Visit public Paper pages" },
        { label: "Review visited pages" },
        { label: "Continue public Paper walkthrough" },
      ],
      browserEvents: [{ id: "visit" }, { id: "review" }, { id: "continue" }],
      otherEvents: [],
    });
  });

  it("preserves narration boundaries and never swallows unrelated tools", () => {
    const narration: AgentMessage = {
      id: "text",
      kind: "text",
      role: "agent",
      text: "Checking the next section.",
      createdAt: 2,
    };
    const shell = {
      ...tool("shell", {}),
      title: "Bash",
      toolKind: "execute",
      rawInput: { command: "pwd" },
    } as AgentToolMessage;
    const grouped = groupBrowserToolActivity([
      tool("open", { tool: "open", arguments: {} }),
      narration,
      tool("read", { tool: "snapshot", arguments: {} }),
      shell,
    ]);
    expect(grouped.map((item) => item.kind)).toEqual([
      "browser-activity",
      "event",
      "browser-activity",
      "event",
    ]);
    expect(
      grouped
        .filter((item) => item.kind === "browser-activity")
        .map((item) => item.actions.length),
    ).toEqual([1, 1]);
    expect(
      grouped
        .filter((item) => item.kind === "browser-activity")
        .map((item) => item.closed),
    ).toEqual([true, true]);
  });

  it("does not settle the latest completed browser burst while the turn can append another action", () => {
    const grouped = groupBrowserToolActivity([
      tool("open", { tool: "open", arguments: {} }),
    ]);

    expect(grouped).toMatchObject([
      {
        kind: "browser-activity",
        closed: false,
        events: [{ status: "completed" }],
      },
    ]);
    const browserGroup = grouped[0];
    expect(
      browserGroup?.kind === "browser-activity" &&
        browserActivityGroupStatus(browserGroup.events, browserGroup.closed),
    ).toBe("browsing");
  });

  it("lets an output rendered outside the working feed close the tail group", () => {
    const grouped = groupBrowserToolActivity(
      [tool("open", { tool: "open", arguments: {} })],
      { closeTail: true },
    );
    const browserGroup = grouped[0];
    expect(
      browserGroup?.kind === "browser-activity" &&
        browserActivityGroupStatus(browserGroup.events, browserGroup.closed),
    ).toBe("used");
  });

  it("starts a new browser subgroup after unrelated work instead of reordering later actions", () => {
    const shell = {
      ...tool("shell", {}),
      title: "Bash",
      toolKind: "execute",
      rawInput: { command: "pwd" },
    } as AgentToolMessage;

    const grouped = groupBrowserToolActivity([
      tool("browser-a", { tool: "open", arguments: {} }),
      shell,
      tool("browser-b", { tool: "snapshot", arguments: {} }),
    ]);

    expect(grouped.map((item) => item.kind)).toEqual([
      "browser-activity",
      "event",
      "browser-activity",
    ]);
  });

  it("uses safe labels and never includes entered text", () => {
    const activity = browserToolActivity(
      tool("type", {
        tool: "type",
        arguments: {
          ref: "b7_0123456789abcdef01234567",
          text: "private password",
        },
      }),
    );
    expect(activity).toMatchObject({ label: "Typed", target: "b7" });
    expect(JSON.stringify(activity)).not.toContain("private password");
  });

  it("reduces a large snapshot result to bounded semantic details", () => {
    const message = tool("snapshot", {
      tool: "snapshot",
      arguments: {},
    });
    message.content = [
      {
        type: "content",
        content: {
          type: "text",
          text: JSON.stringify({
            title: "Example dashboard",
            url: "https://example.com/dashboard",
            text: "a very long page body that must not be rendered here",
            elements: [{ ref: "b1" }, { ref: "b2" }],
          }),
        },
      },
    ];
    expect(browserToolActivity(message)?.detail).toBe(
      "Example dashboard · 2 elements",
    );
    expect(browserToolActivity(message)?.url).toBe(
      "https://example.com/dashboard",
    );
    expect(browserToolActivity(message)?.detail).not.toContain("long page");
  });

  it("keeps a concise browser failure reason available inside the grouped row", () => {
    const message = tool(
      "stopped",
      { tool: "click", arguments: { ref: "b4" } },
      "failed",
    );
    message.content = [
      {
        type: "content",
        content: {
          type: "text",
          text: "Browser work was stopped by the user.\nRetry from a new snapshot.",
        },
      },
    ];
    expect(browserToolActivity(message)?.detail).toBe(
      "Browser work was stopped by the user. Retry from a new snapshot.",
    );
  });

  it("does not relabel completed history with a newer live tab or its favicon", () => {
    const actions = [
      {
        id: "old",
        tool: "snapshot",
        label: "Read page",
        phase: "browse",
        url: "https://old.example/account",
        target: "old.example",
        status: "completed",
      },
    ] satisfies NonNullable<ReturnType<typeof browserToolActivity>>[];

    expect(
      resolveBrowserActivityPresentation(actions, false, {
        url: "https://new.example/dashboard",
        faviconDataUrl: "data:image/png;base64,bmV3",
      }),
    ).toEqual({ host: "old.example" });

    expect(
      resolveBrowserActivityPresentation(actions, true, {
        url: "https://new.example/dashboard",
        faviconDataUrl: "data:image/png;base64,bmV3",
      }),
    ).toEqual({
      host: "new.example",
      faviconDataUrl: "data:image/png;base64,bmV3",
    });

    const sameHostDifferentOrigin = [
      {
        ...actions[0]!,
        url: "https://old.example:8443/account",
      },
    ];
    expect(
      resolveBrowserActivityPresentation(sameHostDifferentOrigin, false, {
        url: "https://old.example:9443/dashboard",
        faviconDataUrl: "data:image/png;base64,b3RoZXItb3JpZ2lu",
      }),
    ).toEqual({ host: "old.example" });
  });

  it("carries each website URL only across its own following browser actions", () => {
    const actions = [
      {
        id: "connect",
        tool: "snapshot",
        label: "Connect to the in-app browser",
        phase: "connect",
        status: "completed",
      },
      {
        id: "apple",
        tool: "open",
        label: "Open MacBook Air",
        phase: "browse",
        url: "https://www.apple.com/macbook-air/",
        status: "completed",
      },
      {
        id: "apple-scroll",
        tool: "scroll",
        label: "Explore M5",
        phase: "browse",
        status: "completed",
      },
      {
        id: "namma",
        tool: "open",
        label: "Open NammaTN",
        phase: "browse",
        url: "https://nammatn.in/welcome",
        status: "completed",
      },
      {
        id: "handoff",
        tool: "close",
        label: "Leave NammaTN open",
        phase: "handoff",
        status: "completed",
      },
    ] satisfies NonNullable<ReturnType<typeof browserToolActivity>>[];

    expect(resolveBrowserActionUrls(actions)).toEqual([
      undefined,
      "https://www.apple.com/macbook-air/",
      "https://www.apple.com/macbook-air/",
      "https://nammatn.in/welcome",
      "https://nammatn.in/welcome",
    ]);
  });
});
