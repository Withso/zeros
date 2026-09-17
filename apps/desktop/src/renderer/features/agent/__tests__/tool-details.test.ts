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
import { generatedImagePath } from "../renderers/tool-artifacts";

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
  it("keeps artifacts beside specialized Read output", () => {
    const html = render(tool({ toolKind: "read", rawInput: { path: "report.txt" }, content: [
      { type: "content", content: { type: "text", text: "Report text" } },
      { type: "content", content: { type: "resource_link", uri: ".context/local/artifacts/chart.png", name: "Chart" } },
    ] }));
    expect(html).toContain("Report text");
    expect(html).toContain('data-file-path=".context/local/artifacts/chart.png"');
  });
  it("keeps a clickable artifact and structured MCP fields alongside text", () => {
    const html = render(tool({ toolKind: "other", rawOutput: { structuredContent: { matches: ["src/a.ts"], data: "Report details" } }, content: [
      { type: "content", content: { type: "text", text: "Report ready" } },
      { type: "content", content: { type: "resource_link", name: "report.html", uri: ".context/local/artifacts/report.html" } },
    ] }));
    expect(html).toContain('data-file-path=".context/local/artifacts/report.html"');
    expect(html).toContain("Report ready");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("Report details");
  });

  it("uses Generate with a file target for image creation, preserving Read for inspection", () => {
    expect(metaForEvent(tool({ toolKind: "other", title: "Generating image", rawOutput: { savedPath: ".context/local/artifacts/scene.png" } }))).toMatchObject({ label: "Generate", target: "scene.png", targetFile: true });
    expect(metaForEvent(tool({ toolKind: "read", rawInput: { path: ".context/local/artifacts/scene.png" } }))).toMatchObject({ label: "Read image", target: "scene.png" });
  });
  it.each(["pending", "in_progress", "failed", "completed"] as const)(
    "does not present a requested image destination as a saved artifact when %s",
    (status) => {
      const requestedPath = ".context/local/artifacts/requested.png";
      for (const key of ["filePath", "file_path"]) {
        const value = tool({
          toolKind: "other",
          title: "Generate image",
          status,
          rawInput: { [key]: requestedPath },
          ...(status === "failed" ? { rawOutput: { error: "Image generation failed" } } : {}),
        });
        expect(generatedImagePath(value)).toBeUndefined();
        expect(metaForEvent(value)).toMatchObject({ label: "Generate", target: undefined, targetFile: false });
        expect(render(value)).not.toContain(`data-file-path="${requestedPath}"`);
      }
    },
  );

  it.each([
    { savedPath: ".context/local/artifacts/actual.png" },
    { filePath: ".context/local/artifacts/actual.png" },
    { value: { filePath: ".context/local/artifacts/actual.png" } },
  ])("uses the confirmed output path for a generated image", (rawOutput) => {
    const value = tool({ toolKind: "other", title: "Generate image", rawInput: { filePath: ".context/local/artifacts/requested.png" }, rawOutput });
    expect(generatedImagePath(value)).toBe(".context/local/artifacts/actual.png");
    expect(render(value)).toContain('data-file-path=".context/local/artifacts/actual.png"');
    expect(render(value)).not.toContain('data-file-path=".context/local/artifacts/requested.png"');
  });

  it("keeps a generated remote image external instead of inventing a file target", () => {
    const remote = tool({ toolKind: "other", title: "Generating image", content: [
      { type: "content", content: { type: "resource_link", uri: "https://example.com/scene.png", name: "Scene" } },
    ] });
    expect(metaForEvent(remote)).toMatchObject({ label: "Generate", target: undefined, targetFile: false });
    expect(render(remote)).toContain('href="https://example.com/scene.png"');
  });
  it("renders a generated file URI once with its native resource name", () => {
    const html = render(tool({ toolKind: "other", title: "Generating image", content: [
      { type: "content", content: { type: "resource_link", uri: "file:///workspace/scene.png", name: "Generated scene" } },
    ] }));
    expect(html.match(/data-file-path="\/workspace\/scene\.png"/g)).toHaveLength(1);
    expect(html).toContain("Generated scene");
  });
  it("does not let a resource-only result hide its captured error", () => {
    const html = render(tool({ status: "failed", rawOutput: "Permission denied while saving report", content: [
      { type: "content", content: { type: "resource_link", uri: ".context/local/artifacts/log.txt", name: "Error log" } },
    ] }));
    expect(html).toContain("Permission denied while saving report");
    expect(html).toContain('data-file-path=".context/local/artifacts/log.txt"');
  });
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
