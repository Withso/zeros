import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { AuthenticationNotice } from "../authentication-notice";
import { PROMPT_SURFACE_RADIUS } from "../composer-shell";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";
import { TurnFailureCard } from "../turn-failure-card";

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

function classList(tag: string | undefined): string[] {
  return tag?.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
}

const renderedNotices = () => [
  renderToStaticMarkup(createElement(EventRowRenderer, { message: notice(), ctx })),
  renderToStaticMarkup(
    createElement(TurnFailureCard, {
      failure: { kind: "protocol-error", message: "Cloud command failed.", newChatAllowed: true },
      onRetry: vi.fn(),
      onRetryNewChat: vi.fn(),
    }),
  ),
  renderToStaticMarkup(createElement(AuthenticationNotice, { name: "Agent", onSignIn: vi.fn() })),
];

const surfaceOf = (html: string) =>
  classList(html.match(/<div[^>]*\sdata-agent-notice\b[^>]*>/)?.[0]);

describe("chat notices", () => {
  it("share the sent message's sans text, 12px corners and 8px/12px padding", () => {
    for (const html of renderedNotices()) {
      const surface = surfaceOf(html);
      expect(surface).toEqual(
        expect.arrayContaining(["bg-brown-bg", "text-fg1", "px-3", "py-2", PROMPT_SURFACE_RADIUS]),
      );
      expect(surface.filter((name) => /^p-|^rounded-(sm|md|lg)$/.test(name))).toEqual([]);
      expect(html).not.toContain("font-mono");
    }
  });

  it("adds outer margin only where the surrounding stack has no gap", () => {
    const [feedNotice, card, auth] = renderedNotices();
    const margins = (html: string) =>
      surfaceOf(html).filter((name) => /^(\w+:)?m[xytblr]?-/.test(name));
    // Feed entries and turn-level notices are spaced by their container's gap.
    expect(margins(feedNotice)).toEqual([]);
    expect(margins(auth)).toEqual([]);
    // The turn lane stacks the failure card with no gap; as its first child
    // the card sits under TurnContainer's gap instead.
    expect(margins(card)).toEqual(["my-2", "first:mt-0"]);
  });

  it("sets actions 4px below the message and pops their color on hover without a fill", () => {
    const [, card, auth] = renderedNotices();
    expect(classList(card.match(/<div[^>]*>(?=<button)/)?.[0])).toContain("mt-1");
    const actions = [card, auth].flatMap((html) =>
      [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => classList(tag)),
    );
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action).toEqual(
        expect.arrayContaining(["text-brown-fg", "hover:bg-transparent", "hover:text-(--agent-notice-action-hover)"]),
      );
      expect(action).not.toContain("hover:bg-bg2-highlight");
      expect(action).not.toContain("hover:bg-brown-fg/10");
      expect(action).not.toContain("mt-2");
      // 6px side padding for the hover wash, offset so the label stays
      // aligned with the message text.
      expect(action).toEqual(expect.arrayContaining(["px-1.5", "-mx-1.5"]));
      expect(action).not.toContain("px-0");
    }
    expect(classList(auth.match(/<button[^>]*>/)?.[0])).toContain("mt-1");
  });

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
