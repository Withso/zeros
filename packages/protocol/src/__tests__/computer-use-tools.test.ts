import { describe, expect, it } from "vitest";

import {
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOL_NAMESPACE,
  DEFAULT_COMPUTER_BLOCKED_APPS,
  computerControlDetail,
  computerUseSettings,
  computerUseWaitText,
  isComputerBundleId,
  isComputerToolName,
  parseComputerToolCall,
  readComputerUsePreferences,
  readComputerUseState,
  readComputerUseStatus,
  resolveComputerUseRoute,
} from "../computer-use-tools";

describe("Zeros computer-use tool contract", () => {
  it("publishes a curated manifest with no script, config or desktop tools", () => {
    expect(COMPUTER_TOOL_NAMESPACE).toBe("zeros_computer");
    expect(COMPUTER_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      COMPUTER_TOOL_NAMES,
    );
    expect(new Set(COMPUTER_TOOL_NAMES).size).toBe(COMPUTER_TOOL_NAMES.length);
    for (const forbidden of [
      "set_config",
      "get_desktop_state",
      "clipboard_read",
      "kill_app",
      "replay_trajectory",
      "browser_navigate",
    ]) {
      expect(isComputerToolName(forbidden)).toBe(false);
    }
    for (const tool of COMPUTER_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toMatch(/\S/);
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("scope");
      expect(Object.keys(tool.inputSchema.properties)).not.toContain(
        "session",
      );
    }
  });

  it("routes every agent, Codex included, by the one switch", () => {
    const defaults = computerUseSettings(undefined);
    expect(defaults).toEqual({
      enabled: true,
      showAgentCursor: true,
      blockedApps: [...DEFAULT_COMPUTER_BLOCKED_APPS],
    });
    const off = { ...defaults, enabled: false };
    expect(
      ["codex", "claude", "cursor", "gemini"].map((agent) => [
        resolveComputerUseRoute(agent, defaults),
        resolveComputerUseRoute(agent, off),
        // A retired `codex_native = true` no longer keeps Codex's built-in.
        resolveComputerUseRoute(agent, computerUseSettings({ enabled: false, codex_native: true })),
      ]),
    ).toEqual([
      ["zeros", "off", "off"],
      ["zeros", "off", "off"],
      ["zeros", "off", "off"],
      ["off", "off", "off"],
    ]);
  });

  it("normalizes the settings table and keeps blocked apps bounded", () => {
    expect(
      computerUseSettings({
        enabled: "yes",
        codex_native: false,
        show_agent_cursor: false,
        blocked_apps: [
          "com.apple.Safari",
          "com.apple.safari",
          " com.apple.Notes ",
          "not a bundle",
          42,
        ],
      }),
    ).toEqual({
      enabled: true,
      showAgentCursor: false,
      blockedApps: ["com.apple.Safari", "com.apple.Notes"],
    });
    // Retired keys have no Settings row, so they change nothing.
    expect(computerUseSettings({ app_access: "ask", codex_native: true })).toEqual(
      computerUseSettings(undefined),
    );
    expect(computerUseSettings({ blocked_apps: [] }).blockedApps).toEqual([]);
    expect(
      computerUseSettings({
        blocked_apps: Array.from({ length: 600 }, (_, i) => `com.example.a${i}`),
      }).blockedApps,
    ).toHaveLength(256);
  });

  it("accepts only reverse-DNS bundle identifiers", () => {
    expect(isComputerBundleId("com.apple.TextEdit")).toBe(true);
    expect(isComputerBundleId("com.1password.1password")).toBe(true);
    expect(isComputerBundleId("TextEdit")).toBe(false);
    expect(isComputerBundleId("com..apple")).toBe(false);
    expect(isComputerBundleId("com.apple.Text Edit")).toBe(false);
    expect(isComputerBundleId(`com.${"a".repeat(300)}`)).toBe(false);
  });

  it("names the app the agent is using on the control bar", () => {
    expect(computerControlDetail("Safari")).toBe("is using Safari");
    expect(computerControlDetail(null)).toBe("is using your Mac");
  });
});

describe("computer tool argument validation", () => {
  const token = "s0a1b2c3d:12";

  it("requires the target app for every action", () => {
    expect(parseComputerToolCall("click", { x: 1, y: 2 })).toEqual({
      ok: false,
      error: "pid is required.",
    });
    expect(
      parseComputerToolCall("screenshot", { pid: 42, window_id: 7 }),
    ).toEqual({
      ok: true,
      call: { tool: "screenshot", pid: 42, windowId: 7 },
    });
    expect(parseComputerToolCall("list_apps", {})).toEqual({
      ok: true,
      call: { tool: "list_apps" },
    });
  });

  it("addresses an element token or a window point, never the desktop", () => {
    expect(
      parseComputerToolCall("click", { pid: 42, element_token: token }),
    ).toEqual({
      ok: true,
      call: { tool: "click", pid: 42, elementToken: token },
    });
    expect(
      parseComputerToolCall("click", {
        pid: 42,
        window_id: 7,
        x: 10.5,
        y: 20,
        button: "right",
        count: 2,
        modifiers: ["cmd", "shift"],
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "click",
        pid: 42,
        windowId: 7,
        x: 10.5,
        y: 20,
        button: "right",
        count: 2,
        modifiers: ["cmd", "shift"],
      },
    });
    expect(parseComputerToolCall("click", { pid: 42 }).ok).toBe(false);
    expect(parseComputerToolCall("click", { pid: 42, x: 1, y: 1 }).ok).toBe(
      false,
    );
    expect(
      parseComputerToolCall("click", { pid: 42, scope: "desktop", x: 1, y: 1 }),
    ).toEqual({ ok: false, error: "Unknown argument: scope." });
    expect(
      parseComputerToolCall("click", { pid: 42, element_token: "s1:2" }).ok,
    ).toBe(false);
  });

  it("bounds text, keys, modifiers and scroll amounts", () => {
    expect(
      parseComputerToolCall("type_text", { pid: 1, text: "x".repeat(20_001) })
        .ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("type_text", { pid: 1, text: "a\u0000b" }).ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("press_key", {
        pid: 1,
        key: "s",
        modifiers: ["cmd"],
      }),
    ).toEqual({
      ok: true,
      call: { tool: "press_key", pid: 1, key: "s", modifiers: ["cmd"] },
    });
    expect(
      parseComputerToolCall("press_key", { pid: 1, key: "return key" }).ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("press_key", {
        pid: 1,
        key: "a",
        modifiers: ["cmd", "cmd"],
      }).ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("scroll", {
        pid: 1,
        direction: "down",
        amount: 51,
      }).ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("scroll", {
        pid: 1,
        direction: "down",
        amount: 5,
        by: "page",
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "scroll",
        pid: 1,
        direction: "down",
        amount: 5,
        by: "page",
      },
    });
  });

  it("drags inside one window and opens apps only by bundle ID", () => {
    expect(
      parseComputerToolCall("drag", {
        pid: 1,
        window_id: 2,
        from_x: 1,
        from_y: 2,
        to_x: 3,
        to_y: 4,
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "drag",
        pid: 1,
        windowId: 2,
        x: 1,
        y: 2,
        toX: 3,
        toY: 4,
      },
    });
    expect(
      parseComputerToolCall("drag", { pid: 1, from_x: 1, from_y: 2, to_x: 3, to_y: 4 })
        .ok,
    ).toBe(false);
    expect(
      parseComputerToolCall("open_app", { bundle_id: "com.apple.TextEdit" }),
    ).toEqual({
      ok: true,
      call: { tool: "open_app", bundleId: "com.apple.TextEdit" },
    });
    expect(
      parseComputerToolCall("open_app", {
        bundle_id: "com.apple.TextEdit",
        urls: ["/etc/passwd"],
      }).ok,
    ).toBe(false);
    expect(parseComputerToolCall("open_app", { name: "TextEdit" }).ok).toBe(
      false,
    );
  });

  it("opens only http and https URLs in an app", () => {
    expect(
      parseComputerToolCall("open_url", {
        bundle_id: "com.google.Chrome",
        url: "https://cursor.com",
      }),
    ).toEqual({
      ok: true,
      call: { tool: "open_url", bundleId: "com.google.Chrome", url: "https://cursor.com/" },
    });
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "x-apple.systempreferences:com.apple.preference.security",
      "https://user:secret@example.com/",
      "not a url",
      `https://example.com/${"a".repeat(9_000)}`,
    ]) {
      expect(parseComputerToolCall("open_url", { bundle_id: "com.google.Chrome", url }).ok).toBe(false);
    }
    expect(parseComputerToolCall("open_url", { url: "https://cursor.com" }).ok).toBe(false);
  });

  it("rejects unknown tools and non-object arguments", () => {
    expect(parseComputerToolCall("set_config", {}).ok).toBe(false);
    expect(parseComputerToolCall("list_apps", null).ok).toBe(false);
    expect(parseComputerToolCall("list_apps", []).ok).toBe(false);
    expect(parseComputerToolCall("list_windows", { pid: -1 }).ok).toBe(false);
  });
});

describe("computer-use state for the transcript", () => {
  const holder = {
    workspaceId: "ws_1",
    conversationId: "conv_a",
    agent: "codex",
    app: "Safari",
  };
  const waiter = { workspaceId: "ws_1", conversationId: "conv_b", agent: "claude" };

  it("reads the snapshot main publishes", () => {
    expect(
      readComputerUseState({ version: 1, holders: [holder], waiting: [waiter] }),
    ).toEqual({ version: 1, holders: [holder], waiting: [waiter] });
    // An older main's `native` flag is read past, not kept.
    expect(
      readComputerUseState({
        version: 1,
        holders: [{ ...holder, app: null, native: false }],
        waiting: [],
      })?.holders[0],
    ).toEqual({ ...holder, app: null });
  });

  it("rejects malformed snapshots", () => {
    for (const value of [
      null,
      { version: 2, holders: [], waiting: [] },
      { version: 1, holders: {}, waiting: [] },
      { version: 1, holders: [{ ...holder, agent: "droid" }], waiting: [] },
      { version: 1, holders: [{ ...holder, app: 3 }], waiting: [] },
      { version: 1, holders: [], waiting: [{ ...waiter, conversationId: "" }] },
      { version: 1, holders: [], waiting: Array(65).fill(waiter) },
      { version: 1, holders: [], waiting: [{ ...waiter, app: 7 }] },
      { version: 1, holders: [], waiting: [{ ...waiter, app: "x".repeat(201) }] },
    ]) {
      expect(readComputerUseState(value)).toBeNull();
    }
  });

  it("keeps the app a chat waits for, and reads snapshots without it", () => {
    expect(
      readComputerUseState({ version: 1, holders: [], waiting: [{ ...waiter, app: "Safari" }] })
        ?.waiting,
    ).toEqual([{ ...waiter, app: "Safari" }]);
    expect(
      readComputerUseState({ version: 1, holders: [], waiting: [{ ...waiter, app: null }] })
        ?.waiting,
    ).toEqual([{ ...waiter, app: null }]);
    expect(
      readComputerUseState({ version: 1, holders: [], waiting: [waiter] })?.waiting[0],
    ).not.toHaveProperty("app");
  });

  it("names the app a chat waits for and the chat using it", () => {
    const notes = { ...holder, conversationId: "conv_c", agent: "cursor", app: "Notes" };
    const waitsForNotes = { ...waiter, app: "Notes" };
    const state = readComputerUseState({
      version: 1,
      holders: [holder, notes],
      waiting: [waitsForNotes],
    });
    expect(computerUseWaitText(state, "conv_b")).toBe(
      "Waiting for Cursor in another chat to finish using Notes",
    );
    // Behind another waiting chat, with nobody holding the app yet.
    expect(
      computerUseWaitText(
        readComputerUseState({ version: 1, holders: [holder], waiting: [waitsForNotes] }),
        "conv_b",
      ),
    ).toBe("Waiting for another chat to finish using Notes");
  });

  it("explains why a chat waits", () => {
    const state = readComputerUseState({
      version: 1,
      holders: [holder],
      waiting: [waiter],
    });
    expect(computerUseWaitText(state, "conv_b")).toBe(
      "Waiting for Codex in another chat to finish using the computer",
    );
    expect(computerUseWaitText(state, "conv_a")).toBeNull();
    expect(computerUseWaitText(null, "conv_b")).toBeNull();
    expect(
      computerUseWaitText(
        { version: 1, holders: [], waiting: [waiter] } as never,
        "conv_b",
      ),
    ).toBe("Waiting for another chat to finish using the computer");
  });
});

describe("computer-use settings between the renderer and main", () => {
  it("reads the preferences Settings pushes to main", () => {
    expect(
      readComputerUsePreferences({
        enabled: true,
        showAgentCursor: false,
        blockedApps: ["com.apple.Safari", "COM.APPLE.SAFARI", "com.apple.Notes"],
      }),
    ).toEqual({
      enabled: true,
      showAgentCursor: false,
      blockedApps: ["com.apple.Safari", "com.apple.Notes"],
    });
    // An older renderer's appAccess is ignored, not a reason to reject.
    expect(
      readComputerUsePreferences({
        enabled: false,
        appAccess: "ask",
        showAgentCursor: true,
        blockedApps: [],
      }),
    ).toEqual({ enabled: false, showAgentCursor: true, blockedApps: [] });
  });

  it("rejects preferences it cannot trust as a whole", () => {
    const valid = { enabled: true, showAgentCursor: true, blockedApps: [] };
    for (const value of [
      null,
      [],
      { ...valid, enabled: "yes" },
      { ...valid, showAgentCursor: undefined },
      { ...valid, blockedApps: "com.apple.Safari" },
      { ...valid, blockedApps: ["com.apple.Safari", "not a bundle"] },
      { ...valid, blockedApps: Array(257).fill("com.apple.Safari") },
    ]) {
      expect(readComputerUsePreferences(value)).toBeNull();
    }
  });

  it("reads the status Settings shows", () => {
    const status = {
      version: 1,
      available: true,
      accessibility: true,
      screenRecording: false,
    };
    expect(readComputerUseStatus(status)).toEqual(status);
    for (const value of [
      null,
      { ...status, version: 2 },
      { ...status, available: "yes" },
      { ...status, accessibility: undefined },
      { ...status, screenRecording: 1 },
    ]) {
      expect(readComputerUseStatus(value)).toBeNull();
    }
  });
});
