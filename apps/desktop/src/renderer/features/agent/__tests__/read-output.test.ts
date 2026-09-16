import { describe, expect, it } from "vitest";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { metaForEvent } from "../renderers/event-meta";

const read = (changes: Partial<AgentToolMessage> = {}): AgentToolMessage => ({
  kind: "tool",
  id: "read",
  toolCallId: "read",
  title: "Read",
  toolKind: "read",
  status: "completed",
  rawInput: { path: "source.ts" },
  createdAt: 1,
  updatedAt: 2,
  ...changes,
});

describe("Read line-count labels", () => {
  it.each([
    ["Claude text result", "  41→first\n  42→second\n"],
    ["Claude text blocks", [{ type: "text", text: "first\nsecond\n" }]],
    [
      "Claude structured read",
      {
        type: "text",
        file: {
          content: "first\nsecond\n",
          numLines: 2,
          totalLines: 415,
          startLine: 41,
        },
      },
    ],
    ["Codex command result", { exitCode: 0, output: "first\nsecond\n" }],
    [
      "Cursor SDK read",
      {
        status: "success",
        value: { content: "first\nsecond\n", totalLines: 2, fileSize: 13 },
      },
    ],
    ["Cursor legacy read", { success: { content: "first\nsecond\n" } }],
    [
      "Cursor protobuf read",
      { result: { case: "success", value: { content: "first\nsecond\n" } } },
    ],
  ])("counts %s without requiring canonical content", (_name, rawOutput) => {
    expect(metaForEvent(read({ rawOutput })).label).toBe("Read 2 lines");
  });

  it.each([false, true])(
    "counts every text block once, preserving blanks and repeated text (raw result: %s)",
    (withRaw) => {
      const tool = read({
        content: [
          { type: "content", content: { type: "text", text: "same\n" } },
          {
            type: "content",
            content: { type: "text", text: "same\n\nlast\n" },
          },
        ],
        ...(withRaw ? { rawOutput: "same\nsame\n\nlast\n" } : {}),
      });
      expect(metaForEvent(tool).label).toBe("Read 4 lines");
    },
  );

  it.each([
    ["", "Read 0 lines"],
    ["\n", "Read 1 line"],
    ["\r\n", "Read 1 line"],
    ["first", "Read 1 line"],
    ["first\n", "Read 1 line"],
    ["first\n\n", "Read 2 lines"],
    ["first\r\nsecond\r\n", "Read 2 lines"],
    ["first\rsecond\r", "Read 2 lines"],
  ])("counts source %j without a phantom trailing row", (text, label) => {
    expect(metaForEvent(read({ rawOutput: text })).label).toBe(label);
  });

  it("counts a partial read's captured lines instead of the requested limit or file size", () => {
    expect(
      metaForEvent(
        read({
          rawInput: { path: "source.ts", offset: 400, limit: 100 },
          rawOutput: { content: "last\nlines\n", totalLines: 415 },
        }),
      ).label,
    ).toBe("Read 2 lines");
  });

  it("counts before the generic raw-output preview is clipped", () => {
    expect(
      metaForEvent(read({ rawOutput: "source line\n".repeat(4000) })).label,
    ).toBe("Read 4000 lines");
  });

  it.each([
    {},
    { rawOutput: { totalLines: 415, fileSize: 20000 } },
    { status: "in_progress" as const },
    { status: "failed" as const, rawOutput: "Permission denied" },
    { rawOutput: { exitCode: 1, output: "Permission denied" } },
    { rawOutput: { status: "error", error: "Permission denied" } },
    {
      rawOutput: {
        content: [{ type: "image", data: "encoded", mimeType: "image/png" }],
      },
    },
  ])(
    "does not invent successful source lines from missing output or errors: %j",
    (changes) => {
      expect(metaForEvent(read(changes)).label).toBe("Read");
    },
  );

  it("keeps image reads distinct from text line counts", () => {
    expect(
      metaForEvent(
        read({ rawInput: { path: "image.png" }, rawOutput: "image metadata" }),
      ).label,
    ).toBe("Read image");
  });
});
