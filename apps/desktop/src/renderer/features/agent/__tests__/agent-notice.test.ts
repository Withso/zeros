import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
  CodeWithGutter: ({ code }: { code: string }) => code,
}));
vi.mock("../markdown", () => ({ renderMarkdown: (text: string) => text }));

const ctx = {
  attachmentImagesActive: false,
  pendingQuestionToolCallIds: new Set(),
  editBaselines: new Map(),
  subagentChildren: new Map(),
} as RendererContext;

function notice(
  overrides: Partial<Extract<AgentMessage, { kind: "error_notice" }>> = {},
): AgentMessage {
  return {
    id: "notice",
    kind: "error_notice",
    createdAt: 1,
    severity: "warning",
    recoverable: true,
    message: "The provider is temporarily unavailable.",
    ...overrides,
  };
}

describe("chat notices", () => {
  it.each(["warning", "error"] as const)(
    "keeps the full %s and safe links readable without a disclosure",
    (severity) => {
      const explanation = "Provider details. ".repeat(20);
      const html = renderToStaticMarkup(
        createElement(EventRowRenderer, {
          message: notice({
            severity,
            message: `${explanation}See https://example.com/help. <script>alert(1)</script> javascript:alert(1)`,
          }),
          ctx,
        }),
      );
      expect(html).toContain(explanation);
      expect(html).toContain('href="https://example.com/help"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain("aria-expanded");
      expect(html).not.toContain("Retry");
    },
  );

  it("keeps automatic reconnect activity separate from manual retries", () => {
    const message = notice({ code: "api_retry" });
    const html = renderToStaticMarkup(
      createElement(EventRowRenderer, {
        message,
        ctx: { ...ctx, isStreaming: true, lastMessageId: message.id },
      }),
    );
    expect(html).toContain("Reconnecting agent");
    expect(html).not.toContain("data-agent-notice");
    expect(html).not.toContain("Retry in new chat");
  });
});
