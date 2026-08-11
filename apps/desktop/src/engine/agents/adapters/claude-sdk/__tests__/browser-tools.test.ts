import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL_DEFINITIONS } from "@zeros/protocol/browser-tools";
import { claudeBrowserTools } from "../adapter";

describe("Claude browser tool adapter", () => {
  it("derives SDK callback tools from the canonical Zeros manifest", async () => {
    const execute = vi.fn(async () => ({
      version: 1 as const,
      success: true,
      content: [{ type: "text" as const, text: "page" }],
    }));
    const tools = claudeBrowserTools({
      browserSessionId: "browser-opaque",
      definitions: BROWSER_TOOL_DEFINITIONS,
      execute,
    });

    expect(tools.map(({ name }) => name)).toEqual(
      BROWSER_TOOL_DEFINITIONS.map(({ name }) => name),
    );
    await expect(
      tools.find(({ name }) => name === "snapshot")?.handler({}, {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "page" }],
      isError: false,
    });
    expect(execute).toHaveBeenCalledWith("snapshot", {});
  });
});
