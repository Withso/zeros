import { describe, expect, it } from "vitest";

import {
  AGENT_CONTROL_FAMILIES,
  BROWSER_CONFIRMATION_DECISIONS,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_NAMESPACE,
  agentControlName,
  browserControlDetail,
  isAgentControlFamily,
  isBrowserElementRef,
  isBrowserConfirmationDecision,
  isBrowserProductId,
  isBrowserToolName,
  browserRouteSettings,
  normalizeBrowserAppearance,
  resolveBrowserRoute,
} from "../browser-tools";

describe("Zeros browser tool contract", () => {
  it("publishes one bounded canonical manifest without provider escape hatches", () => {
    expect(BROWSER_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      BROWSER_TOOL_NAMES,
    );
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length);
    expect(BROWSER_TOOL_NAMESPACE).toBe("zeros_browser");
    expect(BROWSER_TOOL_NAMES).not.toContain("cdp");
    expect(
      BROWSER_TOOL_NAMES.some((name) => name.startsWith("computer_")),
    ).toBe(false);
    for (const tool of BROWSER_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toMatch(/\S/);
    }
  });

  it("validates canonical tool names and bounded Zeros identities", () => {
    expect(isBrowserToolName("snapshot")).toBe(true);
    expect(isBrowserToolName("Runtime.evaluate")).toBe(false);
    expect(isBrowserProductId("conversation:123")).toBe(true);
    expect(isBrowserProductId("codex/thread/123")).toBe(false);
    expect(isBrowserProductId("x".repeat(201))).toBe(false);
    expect(BROWSER_CONFIRMATION_DECISIONS).toEqual([
      "allow-once",
      "allow-site",
      "deny",
    ]);
    expect(isBrowserConfirmationDecision("allow-once")).toBe(true);
    expect(isBrowserConfirmationDecision("auto-approve")).toBe(false);
  });

  it("makes element refs unique to one semantic snapshot", () => {
    expect(isBrowserElementRef("b1_0123456789abcdef01234567")).toBe(true);
    expect(isBrowserElementRef("b300_abcdefabcdefabcdefabcdef")).toBe(true);
    expect(isBrowserElementRef("b1")).toBe(false);
    expect(isBrowserElementRef("b0_0123456789abcdef01234567")).toBe(false);
    expect(isBrowserElementRef("b1_0123456789abcdef0123456g")).toBe(false);
  });

  it("reads the browser table with the shipped defaults", () => {
    expect(browserRouteSettings(undefined)).toEqual({
      codexEnabled: true,
      codexNative: true,
      claudeChrome: false,
      inAppEnabled: true,
    });
    // `enabled` predates the per-provider switches and still governs Codex
    // when `codex_enabled` was never written.
    expect(browserRouteSettings({ enabled: false }).codexEnabled).toBe(false);
    expect(
      browserRouteSettings({ enabled: false, codex_enabled: true }).codexEnabled,
    ).toBe(true);
    expect(
      browserRouteSettings({
        codex_native: false,
        claude_enabled: true,
        in_app_enabled: false,
      }),
    ).toEqual({
      codexEnabled: true,
      codexNative: false,
      claudeChrome: true,
      inAppEnabled: false,
    });
    expect(browserRouteSettings({ codex_native: "no" }).codexNative).toBe(true);
  });

  it.each([
    // agent, codex_enabled, codex_native, claude_enabled, in_app_enabled, route
    ["codex", true, true, false, true, "codex-native"],
    ["codex", true, false, false, true, "zeros"],
    ["codex", true, false, false, false, "zeros"],
    ["codex", false, true, false, true, "off"],
    ["codex", false, false, false, true, "off"],
    ["claude", true, true, false, true, "zeros"],
    ["claude", true, true, true, true, "claude-chrome"],
    ["claude", true, true, true, false, "claude-chrome"],
    ["claude", false, false, false, false, "off"],
    ["cursor", true, true, true, true, "zeros"],
    ["cursor", false, false, false, true, "zeros"],
    ["cursor", true, true, false, false, "off"],
    ["droid", true, true, true, true, "off"],
  ] as const)(
    "routes %s (codex %s, built-in %s, Chrome %s, in-app %s) to %s",
    (agent, codexEnabled, codexNative, claudeChrome, inAppEnabled, route) => {
      expect(
        resolveBrowserRoute(agent, {
          codexEnabled,
          codexNative,
          claudeChrome,
          inAppEnabled,
        }),
      ).toBe(route);
    },
  );

  it("accepts only an explicit light or dark page appearance", () => {
    expect(normalizeBrowserAppearance("light")).toBe("light");
    expect(normalizeBrowserAppearance("dark")).toBe("dark");
    // System is the absence of an override, never a stored value.
    for (const value of ["system", "Dark", "", null, undefined, 1, {}]) {
      expect(normalizeBrowserAppearance(value)).toBeUndefined();
    }
  });

  it("advertises the native Codex IAB host on acquired sessions", () => {
    const response = {
      version: 1,
      browserSessionId: "browser_native",
      capabilities: { codexIab: true },
    } satisfies import("../browser-tools").BrowserSessionAcquireResponse;
    expect(response.capabilities.codexIab).toBe(true);
  });
});

describe("agent control chrome", () => {
  it("names only the agents that drive Zeros control", () => {
    expect(AGENT_CONTROL_FAMILIES).toEqual(["claude", "codex", "cursor"]);
    expect(agentControlName("claude")).toBe("Claude Code");
    expect(agentControlName("codex")).toBe("Codex");
    expect(agentControlName("cursor")).toBe("Cursor");
    for (const value of ["gemini", "Codex", "", null, undefined, 1]) {
      expect(isAgentControlFamily(value)).toBe(false);
    }
  });

  it("says what the agent is doing with the page", () => {
    const action = {
      sequence: 3,
      kind: "click" as const,
      label: "Clicking…",
      startedAt: 1,
    };
    expect(browserControlDetail({ status: "working", action })).toBe(
      "Clicking…",
    );
    expect(
      browserControlDetail({ status: "awaiting-confirmation", action }),
    ).toBe("Waiting for approval");
    // A finished action's label is history, not current work.
    expect(browserControlDetail({ status: "ready", action })).toBe(
      "Using the browser",
    );
    expect(browserControlDetail({ status: "working" })).toBe(
      "Using the browser",
    );
  });
});
