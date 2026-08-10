import { describe, expect, it, vi } from "vitest";

import { handleBrowserMcpRequest } from "../browser-mcp";

describe("isolated browser MCP bridge", () => {
  it("advertises the browser actions to Codex MCP clients", async () => {
    const reply = await handleBrowserMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      vi.fn(),
    );

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(
      expect.objectContaining({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "open" }),
            expect.objectContaining({ name: "snapshot" }),
            expect.objectContaining({ name: "upload" }),
            expect.objectContaining({ name: "trace" }),
            expect.objectContaining({ name: "screenshot" }),
            expect.objectContaining({ name: "computer_screenshot" }),
            expect.objectContaining({ name: "computer_click" }),
            expect.objectContaining({ name: "computer_type" }),
            expect.objectContaining({ name: "computer_key" }),
          ]),
        },
      }),
    );
    const tools = (
      reply.body?.result as { tools: Array<Record<string, unknown>> }
    ).tools;
    expect(tools.find((tool) => tool.name === "open")?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
    );
    expect(tools.find((tool) => tool.name === "click")?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: false, destructiveHint: false }),
    );
    expect(tools.find((tool) => tool.name === "upload")?.inputSchema).toEqual(
      expect.objectContaining({ required: ["ref", "path"] }),
    );
    expect(
      tools.find((tool) => tool.name === "computer_screenshot")?.annotations,
    ).toEqual(expect.objectContaining({ readOnlyHint: true }));
    expect(
      tools.find((tool) => tool.name === "computer_click")?.annotations,
    ).toEqual(expect.objectContaining({ readOnlyHint: false }));
  });

  it("routes tool calls and converts screenshots to MCP image content", async () => {
    const execute = vi.fn(async () => ({
      success: true,
      contentItems: [
        { type: "inputText" as const, text: "Example Domain" },
        {
          type: "inputImage" as const,
          imageUrl: "data:image/png;base64,cG5n",
        },
      ],
    }));
    const reply = await handleBrowserMcpRequest(
      {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "open", arguments: { url: "https://example.com" } },
      },
      execute,
    );

    expect(execute).toHaveBeenCalledWith({
      name: "open",
      arguments: { url: "https://example.com" },
    });
    expect(reply.body).toEqual(
      expect.objectContaining({
        result: {
          content: [
            { type: "text", text: "Example Domain" },
            { type: "image", mimeType: "image/png", data: "cG5n" },
          ],
          isError: false,
        },
      }),
    );
  });

  it("acknowledges client notifications without a response body", async () => {
    await expect(
      handleBrowserMcpRequest(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        vi.fn(),
      ),
    ).resolves.toEqual({ status: 202, body: null });
  });
});
