import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { EventRow } from "../renderers/event-row";
import { CursorTaskCard } from "../renderers/tool-cursor-task";
import {
  EventRowRenderer,
  renderDetail,
} from "../renderers/event-row-renderer";
import { metaForEvent } from "../renderers/event-meta";
import { commandReadActions, displayCommand } from "../renderers/tool-command";
import { isVisibleTranscriptEvent } from "../turn-partition";
import { EventStripe } from "../renderers/event-stripe";
import type { RendererContext } from "../renderers/types";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) =>
    createElement("pre", {}, code),
  CodeWithGutter: ({ code }: { code: string }) =>
    createElement("pre", {}, code),
}));
vi.mock("../markdown", () => ({
  renderMarkdown: (text: string) => text,
  renderMarkdownSegments: (text: string) => [{ type: "html", html: text }],
  fileRefPath: () => null,
}));
const ctx = {
  attachmentImagesActive: false,
  pendingQuestionToolCallIds: new Set(),
  editBaselines: new Map(),
  subagentChildren: new Map(),
} as RendererContext;
const tool = (overrides: Partial<AgentToolMessage> = {}): AgentToolMessage => ({
  kind: "tool",
  id: "row",
  toolCallId: "call",
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});
const row = (value: AgentToolMessage, open = true) =>
  renderToStaticMarkup(
    createElement(EventRow, {
      message: value,
      ctx,
      defaultOpen: open,
      detail: renderDetail(value, ctx),
    }),
  );

describe("tool presentation contract", () => {
  it("presents native Codex waits as coordination without exposing transport ids", () => {
    const waiting = tool({ toolKind: "other", title: "Waiting for agent", status: "in_progress", rawInput: { tool: "wait", senderThreadId: "parent-private-id", receiverThreadIds: ["child-private-id"] } });
    expect(metaForEvent(waiting)).toMatchObject({ label: "Waiting for agent", expandable: false });
    const finished = { ...waiting, status: "completed" as const, rawOutput: { "child-private-id": { status: "completed", message: "Audit complete." } } };
    const html = row(finished);
    expect(html).toContain("Audit complete.");
    expect(html).not.toContain("parent-private-id");
    expect(html).not.toContain("child-private-id");
    expect(html).not.toContain("Background Task");
  });
  it("retains a child failure status beside another child's report in a Codex wait", () => {
    const html = row(tool({ toolKind: "other", title: "Waiting for agents", rawInput: { tool: "wait", receiverThreadIds: ["one", "two"] }, rawOutput: {
      one: { status: "completed", message: "First audit report" }, two: { status: "errored", message: null },
    } }));
    expect(html).toContain("First audit report");
    expect(html).toContain("errored");
  });
  it("keeps unresolved tool rows fully readable inside and outside Agent groups", () => {
    const value = tool({ status: "pending", rawInput: { command: "pnpm test" }, rawOutput: { completionUnreported: true } });
    expect(row(value, false)).not.toContain("opacity-60");
  });

  it("uses the provider's meaningful command description, with Bash as a fallback", () => {
    expect(metaForEvent(tool({ rawInput: { command: "pnpm test", description: "Run the test suite" } })).label).toBe("Run the test suite");
    expect(metaForEvent(tool({ rawInput: { command: "pnpm test", description: "  " } })).label).toBe("Bash");
  });

  it("keeps failed Agent identity and uses one icon slot for disclosure", () => {
    const html = renderToStaticMarkup(createElement(CursorTaskCard, { message: tool({ toolKind: "task", status: "failed", rawInput: { description: "Audit source" } }), ctx }));
    expect(html).toContain('data-agent-icon=""');
    expect(html).toContain("lucide-bot");
    expect(html).not.toContain("lucide-circle-x");
    expect(html).toContain(">Agent<");
    expect(html).toContain("text-red-primary");
  });
  it("keeps current streaming narration bright until the next activity", () => {
    const text = {
      kind: "text" as const,
      role: "agent" as const,
      id: "text",
      text: "Inspecting source",
      createdAt: 1,
    };
    const html = (events: Parameters<typeof EventStripe>[0]["events"]) =>
      renderToStaticMarkup(
        createElement(EventStripe, { events, ctx, live: true }),
      );
    expect(html([text])).toContain('data-live-narration="true"');
    expect(html([text, tool()])).not.toContain('data-live-narration="true"');
  });
  it("unwraps native Cursor search matches, files and counts without guessing unseen lines", () => {
    const value = tool({
      toolKind: "search",
      title: "Grep id:",
      rawInput: { pattern: "id:", path: "src" },
      rawOutput: {
        status: "success",
        value: {
          workspaceResults: {
            "/workspace": {
              type: "content",
              output: {
                matches: [
                  { file: "src/a.ts", lineNumber: 8, line: "id: value" },
                  { file: "src/b.ts" },
                ],
                totalMatches: 2,
              },
            },
          },
        },
      },
    });
    const html = row(value);
    expect(html).toContain("src/a.ts:8: id: value");
    expect(html).toContain("src/b.ts");
    expect(html).not.toContain("workspaceResults");
    expect(html).not.toContain("&quot;status&quot;");
  });
  it("retains native search context and readable list commands on failure", () => {
    const search = tool({
      toolKind: "search",
      title: "Grep id",
      rawInput: { pattern: "id" },
      rawOutput: {
        status: "success",
        value: {
          workspaceResults: {
            "/workspace": {
              type: "content",
              output: {
                matches: [
                  {
                    file: "src/a.ts",
                    lineNumber: 2,
                    line: "id: 1",
                    beforeContext: ["before"],
                    afterContext: ["after"],
                  },
                ],
              },
            },
          },
        },
      },
    });
    const html = row(search);
    expect(html).toContain("before");
    expect(html).toContain("after");
    const list = row(
      tool({
        toolKind: "list",
        title: "List",
        status: "failed",
        rawInput: {
          command: "/bin/zsh -lc 'ls -la'",
          commandActions: [{ type: "listFiles" }],
        },
        rawOutput: { exitCode: 1, output: "Permission denied" },
      }),
    );
    expect(list).toContain("ls -la");
    expect(list).not.toContain("commandActions");
    expect(list).not.toContain("/bin/zsh");
  });
  it("keeps an Agent group collapsed when child output arrives", () => {
    const value = tool({
      toolKind: "task",
      rawInput: { prompt: "Inspect the source", description: "Inspect source" },
      rawOutput: "Inspection result",
    });
    const html = renderToStaticMarkup(
      createElement(CursorTaskCard, {
        message: value,
        ctx: {
          ...ctx,
          subagentChildren: new Map([
            [value.toolCallId, [tool({ id: "child", toolCallId: "child" })]],
          ]),
        },
      }),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Agent<");
    expect(html).not.toContain("data-tool-detail");
    expect(html).not.toContain(">Input<");
  });
  it("withholds incomplete tool previews but always retains terminal failures", () => {
    for (const value of [
      tool({
        status: "in_progress",
        title: "Running shell command",
        rawInput: {},
      }),
      tool({
        status: "in_progress",
        title: "Agent",
        toolKind: "subagent",
        rawInput: {},
      }),
      tool({
        status: "pending",
        title: "Read",
        toolKind: "read",
        rawInput: {},
      }),
    ]) {
      expect(isVisibleTranscriptEvent(value)).toBe(false);
      expect(
        isVisibleTranscriptEvent({
          ...value,
          status: "failed",
          rawOutput: "Connection closed",
        }),
      ).toBe(true);
    }
    expect(
      isVisibleTranscriptEvent(
        tool({ status: "in_progress", rawInput: { command: "pwd" } }),
      ),
    ).toBe(true);
  });
  it("renders thinking as plain text with no elapsed chip or card", () => {
    const value = {
      kind: "text" as const,
      role: "thought" as const,
      id: "thinking",
      text: "Checking the source",
      durationMs: 5000,
      createdAt: 1,
    };
    expect(metaForEvent(value).trailing).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement(EventRow, {
        message: value,
        ctx,
        defaultOpen: true,
        detail: renderDetail(value, ctx),
      }),
    );
    expect(html).toContain("Checking the source");
    expect(html).not.toContain("data-tool-detail");
  });
  it.each(["\n", "\r\n", "\r"])(
    "uses compact thinking paragraphs without provider boundary blanks (%j)",
    (newline) => {
      const nativeText = [
        "", " \t", "First paragraph.", "", " \t", "", "Second paragraph.", "", "",
      ].join(newline);
      const value = {
        kind: "text" as const,
        role: "thought" as const,
        id: "thinking",
        text: nativeText,
        createdAt: 1,
      };
      const html = renderToStaticMarkup(renderDetail(value, ctx));
      expect(html.match(/<p\b/g)).toHaveLength(2);
      expect(html).toContain(">First paragraph.</p>");
      expect(html).toContain(">Second paragraph.</p>");
      expect(value.text).toBe(nativeText);
    },
  );
  it("preserves single thinking line breaks, indentation and literal text", () => {
    const html = renderToStaticMarkup(renderDetail({
      kind: "text",
      role: "thought",
      id: "thinking",
      text: "\n  Inspect <entry>.\n    Keep this indentation.\n",
      createdAt: 1,
    }, ctx));
    expect(html).toContain(">  Inspect &lt;entry&gt;.\n    Keep this indentation.</p>");
  });
  it("does not create empty thinking details for whitespace-only updates", () => {
    expect(renderDetail({
      kind: "text",
      role: "thought",
      id: "thinking",
      text: " \n\t\r\n ",
      createdAt: 1,
    }, ctx)).toBeNull();
  });
  it("uses a stable muted icon while running, and an Error row for failed tools", () => {
    const html = row(
      tool({ status: "in_progress", rawInput: { command: "pwd" } }),
    );
    expect(html).not.toContain('text-fg1" aria-hidden');
    const failed = row(
      tool({ status: "failed", rawOutput: "Permission denied" }),
    );
    expect(failed).toContain(">Error<");
    expect(failed).toContain("bg-red-bg");
  });
  it("keeps one bounded detail card and hides a command preview only while expanded", () => {
    const value = tool({
      rawInput: { command: "pnpm check", description: "Check source" },
      rawOutput: { exitCode: 1, output: "Permission denied", durationMs: 50 },
      status: "failed",
    });
    const html = row(value);
    expect(html.match(/data-tool-detail=""/g)).toHaveLength(1);
    expect(html).toContain("max-h-[320px]");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("Permission denied");
    expect(html).not.toContain("data-tool-preview");
    expect(row(value, false)).toContain("data-tool-preview");
    for (const label of [
      ">Input<",
      ">Output<",
      ">Completed<",
      "Exit code:",
      "Duration:",
    ])
      expect(html).not.toContain(label);
    expect(metaForEvent(value).label).toBe("Check source");
  });

  it("keeps file identity visible in an expanded read", () => {
    const html = row(
      tool({
        toolKind: "read",
        rawInput: { file_path: "src/a.ts" },
        content: [
          { type: "content", content: { type: "text", text: "const a = 1;" } },
        ],
      }),
    );
    expect(html).toContain("a.ts");
    expect(html).toContain("const a = 1;");
  });

  it("keeps a normal Cursor Glob compact but makes failures inspectable", () => {
    const value = tool({
      toolKind: "search",
      title: "Glob",
      rawInput: { globPattern: "**/*.ts", targetDirectory: "src" },
      content: [
        { type: "content", content: { type: "text", text: "src/a.ts" } },
      ],
    });
    expect(metaForEvent(value)).toMatchObject({
      label: "Glob",
      target: "**/*.ts",
      expandable: false,
    });
    expect(row(value)).not.toContain("aria-expanded");
    expect(
      row({
        ...value,
        status: "failed",
        rawOutput: "Permission denied",
        content: [],
      }),
    ).toContain("Permission denied");
  });

  it("does not call an unknown tool's description 'other'", () => {
    expect(
      metaForEvent(tool({ toolKind: "other", title: "Tool" })).target,
    ).toBeUndefined();
  });

  it.each(["cancelled", "declined", "interrupted"])(
    "preserves the native %s explanation without diagnostic badges",
    (status) => {
      const html = row(
        tool({
          status: "failed",
          rawInput: { command: "check" },
          rawOutput: { status, exitCode: null, output: "" },
        }),
      );
      expect(html).toContain(`The tool was ${status}.`);
      expect(html).not.toContain("without an explanation");
    },
  );

  it("does not render a successful read's native metadata envelope as source code", () => {
    const value = tool({
      toolKind: "read",
      rawInput: { path: "empty.ts" },
      rawOutput: {
        status: "success",
        value: { content: "", totalLines: 0, fileSize: 0 },
      },
    });
    const html = row(value);
    expect(metaForEvent(value).label).toBe("Read 0 lines");
    expect(html).not.toContain("totalLines");
    expect(html).not.toContain("fileSize");
    expect(html).toContain("No lines returned.");
  });

  it("labels native batched reads with an explicit shared total, not per-file counts", () => {
    const value = tool({
      rawInput: {
        command: "cat a.ts b.ts",
        commandActions: [
          { type: "read", path: "a.ts", command: "cat a.ts", name: "a.ts" },
          { type: "read", path: "b.ts", command: "cat b.ts", name: "b.ts" },
        ],
      },
      rawOutput: { output: "shared result", exitCode: 0 },
    });
    expect(commandReadActions(value)).toHaveLength(2);
    const html = renderToStaticMarkup(
      createElement(EventRowRenderer, { message: value, ctx }),
    );
    expect(html).toContain("a.ts");
    expect(html).toContain("b.ts");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html.match(/>Read 1 line total</g)).toHaveLength(2);
    expect(commandReadActions({ ...value, status: "failed" })).toEqual(
      commandReadActions(value),
    );
  });
});

describe("display-only shell commands", () => {
  it.each([
    ["/bin/zsh -lc 'cat package.json'", "cat package.json"],
    ['bash -l -c "printf \\"hello\\""', 'printf "hello"'],
    ["/bin/bash -c 'printf '\\''quoted'\\'''", "printf 'quoted'"],
    ["/bin/sh -c 'echo a\necho b'", "echo a\necho b"],
    ["echo $(whoami)", "echo $(whoami)"],
    ["env KEY=value bash -c 'echo ok'", "env KEY=value bash -c 'echo ok'"],
    ["bash -c 'echo $0' extra-argument", "bash -c 'echo $0' extra-argument"],
    ['bash -c "echo $VAR"', 'bash -c "echo $VAR"'],
    ["bash -c 'unterminated", "bash -c 'unterminated"],
  ])(
    "unwraps only a complete literal shell wrapper: %s",
    (command, expected) => {
      expect(displayCommand({ command })).toBe(expected);
    },
  );
  it("uses argv's literal command without executing substitutions", () => {
    expect(
      displayCommand({ command: ["/bin/zsh", "-lc", "echo $(whoami)"] }),
    ).toBe("echo $(whoami)");
  });
  it("leaves mixed command actions as one execution", () => {
    expect(
      commandReadActions(
        tool({
          rawInput: {
            commandActions: [
              { type: "read", path: "a" },
              { type: "unknown", command: "rm a" },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });
});
