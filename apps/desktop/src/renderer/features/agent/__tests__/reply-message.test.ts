import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TextMessage } from "../renderers/text-message";
import type { RendererContext } from "../renderers/types";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import { formatReply } from "../chat-selection";

vi.mock("../markdown", () => ({
  renderMarkdownSegments: (text: string) => [{ type: "html", html: text }],
  createStreamingMarkdownRenderer: () => (text: string) => [{ type: "html", html: text }],
  fileRefPath: () => null,
}));

const render = (element: ReactElement) => renderToStaticMarkup(h(TooltipProvider, null, element));
const ctx = { isStreaming: false, attachmentImagesActive: false } as RendererContext;
const message = (text: string, extra: object = {}) => ({
  id: "m", kind: "text" as const, role: "user" as const, createdAt: 1, text, ...extra,
});
const sent = formatReply("to their mode IDs. I made a test session on Ultra to check it worked, then…", "Great");

describe("a sent reply", () => {
  it("shows the quote on one line and ↳ the reply", () => {
    const html = render(h(TextMessage, { message: message(sent), ctx }));
    expect(html).toContain("data-reply-message");
    expect(html).toMatch(/data-reply-quote=""[^>]*>.*“.*to their mode IDs\. I made a test session on Ultra/);
    expect(html).toContain("lucide-corner-down-right");
    expect(html).toMatch(/>Great<\/span>|>Great</);
    expect(html).not.toContain("&gt; to their");
  });

  it("reads the same from composer segments", () => {
    const html = render(h(TextMessage, { message: message(sent, { segments: [{ type: "text", text: sent }] }), ctx }));
    expect(html).toContain("data-reply-message");
  });

  it("keeps an attached long quote's chip above the reply", () => {
    const html = render(h(TextMessage, {
      message: message(sent, { attachments: [{ name: "chat-selection-2026-11-22_00-31-48.txt", mimeType: "text/plain", kind: "text" }] }),
      ctx,
    }));
    expect(html).toContain("chat-selection-2026-11-22_00-31-48.txt");
    expect(html).toContain("data-reply-message");
  });

  it("leaves other messages as they were", () => {
    for (const text of ["> a quote with no reply", "Plain\n\n> later quote"]) {
      expect(render(h(TextMessage, { message: message(text), ctx }))).not.toContain("data-reply-message");
    }
    const pill = { type: "attachment", name: "a.txt", mimeType: "text/plain", kind: "text" };
    expect(render(h(TextMessage, {
      message: message(sent, { segments: [{ type: "text", text: sent }, pill] }), ctx,
    }))).not.toContain("data-reply-message");
    expect(render(h(TextMessage, { message: message(sent, { role: "agent" }), ctx }))).not.toContain("data-reply-message");
  });
});
