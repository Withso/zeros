import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL_DEFINITIONS } from "@zeros/protocol/browser-tools";
import {
  codexBrowserDynamicTools,
  createCodexBrowserToolHandler,
} from "../browser-tools";

describe("Codex browser tool adapter", () => {
  it("derives the namespace from the canonical Zeros manifest", () => {
    const tools = codexBrowserDynamicTools(binding());
    expect(tools?.[0]).toMatchObject({
      type: "namespace",
      name: "zeros_browser",
    });
    expect(
      (tools?.[0] as { tools: Array<{ name: string }> }).tools.map(
        ({ name }) => name,
      ),
    ).toEqual(BROWSER_TOOL_DEFINITIONS.map(({ name }) => name));
  });

  it("rejects another namespace before invoking Zeros", async () => {
    const value = binding();
    const handler = createCodexBrowserToolHandler(value);
    await expect(
      handler?.({
        threadId: "thread-or-subagent-is-not-an-owner",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "provider_owned_browser",
        tool: "snapshot",
        arguments: {},
      }),
    ).resolves.toMatchObject({ success: false });
    expect(value.execute).not.toHaveBeenCalled();
  });
});

function binding() {
  return {
    browserSessionId: "browser-1",
    definitions: BROWSER_TOOL_DEFINITIONS,
    execute: vi.fn(async () => ({
      version: 1 as const,
      success: true,
      content: [{ type: "text" as const, text: "ok" }],
    })),
  };
}
