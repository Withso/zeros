import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL_DEFINITIONS } from "@zeros/protocol/browser-tools";
import { cursorBrowserCustomTools } from "../../browser/adapter-tools";

describe("provider-neutral browser adapter tools", () => {
  it("derives Cursor tools from the canonical manifest and preserves results", async () => {
    const execute = vi.fn(async () => ({
      version: 1 as const,
      success: true,
      content: [{ type: "text" as const, text: "page" }],
    }));
    const tools = cursorBrowserCustomTools({
      browserSessionId: "browser-1",
      definitions: BROWSER_TOOL_DEFINITIONS,
      execute,
    });

    expect(Object.keys(tools ?? {})).toEqual(
      BROWSER_TOOL_DEFINITIONS.map(({ name }) => `zeros_browser_${name}`),
    );
    await expect(tools?.zeros_browser_snapshot?.execute({})).resolves.toEqual({
      content: [{ type: "text", text: "page" }],
      isError: false,
    });
    expect(execute).toHaveBeenCalledWith("snapshot", {});
  });
});
