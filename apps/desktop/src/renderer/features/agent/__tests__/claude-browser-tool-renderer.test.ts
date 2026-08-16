import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventRowRenderer } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";
import type { AgentToolMessage } from "../use-agent-session";

const ctx = {
  chatId: "claude-chat",
  isStreaming: false,
  lastMessageId: null,
  editBaselines: new Map(),
} as unknown as RendererContext;

describe("Claude Chrome tool rendering", () => {
  it("renders an official extension call as semantic Browser activity", () => {
    const message = {
      id: "chrome-tool",
      kind: "tool",
      toolCallId: "chrome-tool",
      title: "mcp__claude-in-chrome__navigate",
      toolKind: "mcp",
      status: "completed",
      rawInput: {
        url: "https://example.com/private?token=not-for-the-row",
      },
      createdAt: 1,
      updatedAt: 2,
    } as AgentToolMessage;

    const html = renderToStaticMarkup(
      createElement(EventRowRenderer as never, { message, ctx }),
    );

    expect(html).toContain("Opened");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("mcp__claude-in-chrome__navigate");
    expect(html).not.toContain("not-for-the-row");
  });
});
