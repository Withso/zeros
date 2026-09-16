import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderDetail } from "../renderers/event-row-renderer";
import { metaForEvent } from "../renderers/event-meta";
import type { AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "../renderers/types";
import { CompactionRecordCard } from "../renderers/compaction-card";
import { QuestionRecordCard } from "../renderers/question-card";
import { CursorTaskCard } from "../renderers/tool-cursor-task";
import { SubagentCard } from "../renderers/tool-subagent";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
  CodeWithGutter: ({ code }: { code: string }) => code,
}));
vi.mock("../markdown", () => ({ renderMarkdown: (text: string) => text }));

function tool(overrides: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: "tool",
    id: "tool-t",
    toolCallId: "t",
    title: "Bash",
    toolKind: "execute",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
const render = (value: AgentToolMessage) =>
  renderToStaticMarkup(
    renderDetail(value, { attachmentImagesActive: true } as RendererContext),
  );

describe("expanded tool details", () => {
  it("renders an unfamiliar structured result once", () => {
    const html = render(tool({ rawOutput: { message: "A unique result" } }));
    expect(html.match(/A unique result/g)).toHaveLength(1);
  });

  it("renders audio controls and resource descriptions without disclosing bytes", () => {
    const html = render(
      tool({
        content: [
          {
            type: "content",
            content: { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
          },
          {
            type: "content",
            content: {
              type: "resource_link",
              uri: "https://example.com/report",
              name: "Report",
              description: "Generated report",
            },
          },
        ],
      }),
    );
    expect(html).toContain("<audio");
    expect(html).toContain('preload="none"');
    expect(html).toContain("Generated report");
    expect(html).not.toContain("&quot;data&quot;");
  });

  it("does not attribute an old uncaptured web result to the provider", () => {
    expect(
      render(tool({ toolKind: "web_search", rawInput: { query: "example" } })),
    ).toContain("No search results were captured for this call.");
  });
  it("keeps compaction and pending question records inspectable", () => {
    const ctx = {
      pendingQuestionToolCallIds: new Set(["t"]),
    } as RendererContext;
    const compaction = renderToStaticMarkup(
      createElement(CompactionRecordCard, {
        message: tool({ toolKind: "compaction", status: "in_progress" }),
        ctx,
      }),
    );
    expect(compaction).toContain('aria-expanded="false"');
    const question = renderToStaticMarkup(
      createElement(QuestionRecordCard, {
        message: tool({
          toolKind: "question",
          rawInput: {
            questions: [
              { question: "Which format?", options: ["JSON", "CSV"] },
            ],
          },
        }),
        ctx,
      }),
    );
    expect(question).toContain('aria-expanded="false"');
  });
  it("shows the full command without execution metadata when no output was captured", () => {
    const html = render(
      tool({
        rawInput: {
          command: "pnpm typecheck > /tmp/check.log 2>&1",
          cwd: "/workspace",
        },
        rawOutput: { exitCode: 0, output: null },
      }),
    );
    expect(html).toContain("pnpm typecheck");
    expect(html).not.toContain("/workspace");
    expect(html).not.toContain("Exit code:");
    expect(html).toContain("No output was captured");
  });

  it("keeps the command and failure output without status chrome", () => {
    const html = render(
      tool({
        status: "failed",
        rawInput: { command: "pnpm check" },
        rawOutput: { exitCode: 143, output: "Server ready" },
        content: [
          { type: "content", content: { type: "text", text: "Server ready" } },
        ],
      }),
    );
    expect(html).toContain("pnpm check");
    expect(html).toContain("Server ready");
    expect(html).not.toContain("Exit code:");
    expect(html).not.toContain(">Failed<");
  });

  it("keeps Cursor failure output without exposing the SDK wrapper", () => {
    const html = render(tool({
      status: "failed",
      rawOutput: { status: "success", value: { exitCode: 1, stdout: "Started", stderr: "Permission denied" } },
      content: [{ type: "content", content: { type: "text", text: "Started\nPermission denied" } }],
    }));
    expect(html).not.toContain("Exit code:");
    expect(html).not.toContain(">Failed<");
    expect(html.match(/Permission denied/g)).toHaveLength(1);
  });

  it("does not count a Read failure message as lines successfully read", () => {
    const value = tool({ toolKind: "read", status: "failed", rawInput: { path: "denied.ts" }, content: [{ type: "content", content: { type: "text", text: "Permission denied" } }] });
    expect(metaForEvent(value).label).toBe("Read");
    expect(render(value)).toContain("Permission denied");
  });

  it("describes a stopped unresolved tool without promising more output", () => {
    const html = render(tool({ status: "pending", rawOutput: { _zerosToolCompletion: "unreported" } }));
    expect(html).toContain("Completion not reported");
    expect(html).not.toContain("Waiting for output");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("_zerosToolCompletion");
  });

  it.each([CursorTaskCard, SubagentCard])("does not animate a child whose completion was never reported", (Card) => {
    const ctx = { subagentChildren: new Map(), pendingQuestionToolCallIds: new Set() } as unknown as RendererContext;
    const html = renderToStaticMarkup(createElement(Card, {
      message: tool({ status: "pending", rawOutput: { _zerosToolCompletion: "unreported" } }), ctx,
    }));
    expect(html).not.toContain('role="status"');
  });

  it("shows web actions and results even without a query string", () => {
    const value = tool({
      toolKind: "web_search",
      rawInput: {
        query: "",
        action: {
          type: "find_in_page",
          url: "https://example.com/docs",
          pattern: "API",
        },
      },
      rawOutput: {
        results: [{ title: "Example", snippet: "API documentation" }],
      },
    });
    expect(metaForEvent(value)).toMatchObject({
      label: "Find in page",
      target: expect.stringContaining("API"),
    });
    const html = render(value);
    expect(html).toContain("https://example.com/docs");
    expect(html).toContain("API documentation");
  });

  it("makes missing web results explicit", () => {
    const html = render(
      tool({
        toolKind: "web_search",
        rawInput: { query: "example" },
        rawOutput: { results: null },
      }),
    );
    expect(html).toContain("example");
    expect(html).toContain("The provider did not include search results");
  });

  it("preserves tool input next to media without displaying encoded bytes as text", () => {
    const html = render(
      tool({
        rawInput: { path: "/workspace/image.png" },
        content: [
          {
            type: "content",
            content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          },
        ],
      }),
    );
    expect(html).toContain("/workspace/image.png");
    expect(html).toContain("<img");
    expect(html).not.toContain("&quot;data&quot;");
  });
});
