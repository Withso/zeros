import { describe, expect, it } from "vitest";

import {
  BROWSER_CONFIRMATION_DECISIONS,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_NAMESPACE,
  isBrowserElementRef,
  isBrowserConfirmationDecision,
  isBrowserProductId,
  isBrowserToolName,
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

  it("advertises the native Codex IAB host on acquired sessions", () => {
    const response = {
      version: 1,
      browserSessionId: "browser_native",
      capabilities: { codexIab: true },
    } satisfies import("../browser-tools").BrowserSessionAcquireResponse;
    expect(response.capabilities.codexIab).toBe(true);
  });
});
