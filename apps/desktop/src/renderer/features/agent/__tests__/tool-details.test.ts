import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderDetail } from "../renderers/event-row-renderer";
import { metaForEvent } from "../renderers/event-meta";
import type { AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "../renderers/types";
import { CompactionRecordCard } from "../renderers/compaction-card";
import { QuestionRecordCard } from "../renderers/question-card";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
  CodeWithGutter: ({ code }: { code: string }) => code,
}));

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
  it("shows a full command and cwd even when a successful command captured no output", () => {
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
    expect(html).toContain("/workspace");
    expect(html).toContain("Exit code: 0");
    expect(html).toContain("No output was captured");
  });

  it("shows failure output, input and exact exit status together", () => {
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
    expect(html).toContain("Exit code: 143");
    expect(html).toContain("Failed");
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
