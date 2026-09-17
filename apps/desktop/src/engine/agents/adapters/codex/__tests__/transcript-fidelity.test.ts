import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CodexAppServerTranslator } from "../app-server-translator";
import type { QuestionRequest } from "@zeros/protocol/agent-events";

function transcript() {
  let messages: AgentMessage[] = [];
  const translator = new CodexAppServerTranslator({
    sessionId: "session",
    emit: (notification) => {
      messages = applyUpdate(messages, notification);
    },
  });
  const item = (value: Record<string, unknown>, completed = true) =>
    translator.handle(completed ? "item/completed" : "item/started", {
      item: value,
    });
  return { translator, item, messages: () => messages };
}

describe("Codex transcript fidelity", () => {
  it("recovers missing item completions from a full terminal turn snapshot", () => {
    const t = transcript();
    t.item({ type: "agentMessage", id: "reply", text: "Draft" }, false);
    t.item({ type: "commandExecution", id: "cmd", command: "check", status: "inProgress" }, false);
    const turn = { id: "turn", status: "completed", itemsView: "full", items: [
      { type: "agentMessage", id: "reply", text: "Final answer", phase: "final_answer" },
      { type: "commandExecution", id: "cmd", command: "check", status: "completed", exitCode: 1, aggregatedOutput: "Permission denied" },
    ] };
    t.translator.handle("turn/completed", { turn });
    t.translator.handle("turn/completed", { turn });
    expect(t.messages()).toEqual([
      expect.objectContaining({ text: "Final answer", phase: "final_answer" }),
      expect.objectContaining({ status: "failed", rawOutput: expect.objectContaining({ output: "Permission denied" }) }),
    ]);
  });

  it("does not invent item completion from a summary or unfinished snapshot item", () => {
    const t = transcript();
    t.translator.handle("turn/completed", { turn: { id: "turn", status: "completed", itemsView: "summary", items: [{ type: "agentMessage", id: "reply", text: "Summary is not the answer" }] } });
    expect(t.messages()).toEqual([]);
    t.translator.handle("turn/completed", { turn: { id: "turn", status: "completed", itemsView: "full", items: [{ type: "commandExecution", id: "cmd", command: "check", status: "inProgress" }] } });
    expect(t.messages()[0]).toMatchObject({ status: "in_progress" });
  });

  it("does not infer a command outcome when a malformed full snapshot omits status", () => {
    const t = transcript();
    t.translator.handle("turn/completed", { turn: { id: "turn", status: "completed", itemsView: "full", items: [{ type: "commandExecution", id: "cmd", command: "check" }] } });
    expect(t.messages()[0]).toMatchObject({ status: "in_progress" });
  });

  it.each(["completed", "failed", "declined"])(
    "retains streamed file-edit output after %s completion and replay",
    (status) => {
      const t = transcript();
      const edit = {
        type: "fileChange",
        id: "edit",
        changes: [
          {
            path: "a.ts",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      };
      t.item(edit, false);
      t.translator.handle("item/fileChange/outputDelta", {
        itemId: "edit",
        delta: "Patch diagnostic: ",
      });
      t.translator.handle("item/fileChange/outputDelta", {
        itemId: "edit",
        delta: "expected lines were not found",
      });
      t.item({ ...edit, status });
      const settled = t.messages()[0];
      expect(settled).toMatchObject({
        status: status === "completed" ? "completed" : "failed",
        rawOutput: {
          status,
          output: "Patch diagnostic: expected lines were not found",
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Patch diagnostic: expected lines were not found",
            },
          },
        ],
      });
      t.item(edit, false);
      t.translator.handle("item/fileChange/outputDelta", {
        itemId: "edit",
        delta: "stale output",
      });
      t.translator.handle("item/fileChange/patchUpdated", {
        itemId: "edit",
        changes: [],
      });
      t.item({ ...edit, status });
      expect(t.messages()).toEqual([settled]);
      expect(t.messages()[0]).toBe(settled);
    },
  );

  it("does not reopen a completed edit when a patch notification arrives late", () => {
    const t = transcript();
    t.item({
      type: "fileChange",
      id: "edit",
      changes: [],
      status: "completed",
    });
    const settled = t.messages()[0];
    t.translator.handle("item/fileChange/patchUpdated", {
      itemId: "edit",
      changes: [],
    });
    expect(t.messages()[0]).toBe(settled);
  });

  it("updates a live patch without overwriting its captured diagnostic", () => {
    const t = transcript();
    t.item({ type: "fileChange", id: "edit", changes: [] }, false);
    t.translator.handle("item/fileChange/outputDelta", {
      itemId: "edit",
      delta: "Patch diagnostic",
    });
    const changes = [
      {
        path: "a.ts",
        kind: { type: "update" },
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    t.translator.handle("item/fileChange/patchUpdated", {
      itemId: "edit",
      changes,
    });
    expect(t.messages()[0]).toMatchObject({
      rawInput: { changes },
      rawOutput: "Patch diagnostic",
      status: "in_progress",
    });
  });

  it.each(["summary", "content"] as const)(
    "appends reasoning deltas to an existing %s snapshot",
    (field) => {
      const t = transcript();
      t.item(
        { type: "reasoning", id: "reason", [field]: ["First", "Second"] },
        false,
      );
      t.translator.handle(
        field === "summary"
          ? "item/reasoning/summaryTextDelta"
          : "item/reasoning/textDelta",
        {
          itemId: "reason",
          summaryIndex: 1,
          contentIndex: 1,
          delta: " continued",
        },
      );
      expect(t.messages()).toEqual([
        expect.objectContaining({
          role: "thought",
          text: "First\n\nSecond continued",
        }),
      ]);
    },
  );

  it("keeps readable content while a reasoning summary is still empty", () => {
    const t = transcript();
    t.item(
      { type: "reasoning", id: "reason", summary: [""], content: ["First"] },
      false,
    );
    t.translator.handle("item/reasoning/textDelta", {
      itemId: "reason",
      contentIndex: 0,
      delta: " continued",
    });
    expect(t.messages()[0]).toMatchObject({ text: "First continued" });
    t.translator.handle("item/reasoning/summaryTextDelta", {
      itemId: "reason",
      summaryIndex: 0,
      delta: "Readable summary",
    });
    expect(t.messages()).toEqual([
      expect.objectContaining({ text: "Readable summary" }),
    ]);
  });

  it("ignores empty summary placeholders in started and completed reasoning snapshots", () => {
    const t = transcript();
    const item = {
      type: "reasoning",
      id: "reason",
      summary: ["", ""],
      content: ["Readable content"],
    };
    t.item(item, false);
    expect(t.messages()[0]).toMatchObject({ text: "Readable content" });
    t.item({ ...item, content: ["Completed content"] });
    expect(t.messages()).toEqual([
      expect.objectContaining({ text: "Completed content" }),
    ]);
  });

  it("keeps interleaved tool output isolated and prefers an authoritative command aggregate", () => {
    const t = transcript();
    t.item({ type: "fileChange", id: "edit", changes: [] }, false);
    t.item(
      { type: "commandExecution", id: "command", command: "check" },
      false,
    );
    t.translator.handle("item/fileChange/outputDelta", {
      itemId: "edit",
      delta: "Edit output",
    });
    t.translator.handle("item/commandExecution/outputDelta", {
      itemId: "command",
      delta: "Command draft",
    });
    t.item({
      type: "commandExecution",
      id: "command",
      command: "check",
      status: "completed",
      aggregatedOutput: "Corrected output",
      exitCode: 0,
    });
    t.item({ type: "fileChange", id: "edit", changes: [], status: "failed" });
    expect(t.messages()[0]).toMatchObject({
      rawOutput: { output: "Edit output" },
    });
    expect(t.messages()[1]).toMatchObject({
      rawOutput: { output: "Corrected output" },
    });
    t.translator.startTurn();
    t.item({
      type: "fileChange",
      id: "edit",
      changes: [],
      status: "completed",
    });
    expect(t.messages()[2]).toMatchObject({
      rawOutput: { status: "completed" },
    });
    expect(t.messages()[2]).not.toHaveProperty("rawOutput.output");
  });

  it("preserves MCP audio and linked or embedded resources", () => {
    const t = transcript();
    const content = [
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      {
        type: "resource_link",
        uri: "https://example.com/report",
        name: "Report",
        description: "Generated report",
      },
      {
        type: "resource",
        resource: {
          uri: "file:///workspace/report.txt",
          text: "Report body",
          mimeType: "text/plain",
        },
      },
    ];
    t.item({
      type: "mcpToolCall",
      id: "mcp",
      server: "example",
      tool: "report",
      status: "completed",
      result: { content },
    });
    expect(t.messages()[0]).toMatchObject({
      content: content.map((block) => ({ type: "content", content: block })),
    });
  });
  it("retains streamed command output when completion has no aggregate", () => {
    const t = transcript();
    t.item({ type: "commandExecution", id: "cmd", command: "check" }, false);
    t.translator.handle("item/commandExecution/outputDelta", {
      itemId: "cmd",
      delta: "Captured output",
    });
    t.item({
      type: "commandExecution",
      id: "cmd",
      command: "check",
      aggregatedOutput: null,
      exitCode: 0,
    });
    expect(t.messages()[0]).toMatchObject({
      rawOutput: { output: "Captured output" },
    });
  });

  it("keeps native plan text in commentary rather than promoting it to the answer", () => {
    const t = transcript();
    t.item({ type: "plan", id: "plan", text: "" }, false);
    t.translator.handle("item/plan/delta", {
      itemId: "plan",
      delta: "Inspect and fix",
    });
    t.item({ type: "plan", id: "plan", text: "Inspect and fix" });
    expect(t.messages()[0]).toMatchObject({
      text: "Inspect and fix",
      phase: "commentary",
    });
  });

  it("does not label a command reading different files as a read of the first file", () => {
    const t = transcript();
    t.item({
      type: "commandExecution",
      id: "cmd",
      command: "cat a.ts b.ts",
      commandActions: [
        { type: "read", path: "a.ts" },
        { type: "read", path: "b.ts" },
      ],
      exitCode: 0,
    });
    expect(t.messages()[0]).toMatchObject({
      toolKind: "execute",
      rawInput: { command: "cat a.ts b.ts" },
    });
  });
  it("turns native async questions into one non-blocking question request and durable record", () => {
    const requests: QuestionRequest[] = [];
    let messages: AgentMessage[] = [];
    const translator = new CodexAppServerTranslator({
      sessionId: "session",
      emit: (event) => {
        messages = applyUpdate(messages, event);
      },
      onAsyncQuestion: (request) => requests.push(request),
    });
    const item = {
      type: "agentMessage",
      id: "ask",
      delivery: "async",
      text: "Choose a format",
      phase: "final_answer",
      questions: [
        { title: "Which format?", options: ["JSON", "CSV"] },
        { title: "Any constraints?", options: null },
      ],
    };
    translator.handle("item/started", { item });
    translator.handle("item/completed", { item });
    translator.handle("item/completed", { item });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      blocking: false,
      questions: [
        {
          prompt: "Which format?",
          defaultOptionIds: ["option-0"],
          allowOther: true,
        },
        { prompt: "Any constraints?", options: [], allowOther: true },
      ],
    });
    expect(messages).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolKind: "question",
        rawInput: {
          delivery: "async",
          text: "Choose a format",
          questions: [
            { question: "Which format?", options: ["JSON", "CSV"] },
            { question: "Any constraints?", options: null },
          ],
        },
      }),
    ]);
  });
  it("reconciles authoritative text after interleaved tools, including corrections and replay", () => {
    const t = transcript();
    t.item({ type: "agentMessage", id: "reply", text: "Draft" }, false);
    t.item({ type: "commandExecution", id: "cmd", command: "pwd" }, false);
    t.item({
      type: "agentMessage",
      id: "reply",
      text: "Final",
      phase: "final_answer",
    });
    t.item({
      type: "agentMessage",
      id: "reply",
      text: "Final",
      phase: "final_answer",
    });
    t.translator.handle("item/agentMessage/delta", {
      itemId: "reply",
      delta: "stale",
    });
    expect(t.messages().filter((m) => m.kind === "text")).toEqual([
      expect.objectContaining({ text: "Final", phase: "final_answer" }),
    ]);
  });

  it("uses readable reasoning snapshots and preserves summary part boundaries", () => {
    const t = transcript();
    t.translator.handle("item/reasoning/summaryTextDelta", {
      itemId: "r",
      summaryIndex: 1,
      delta: "Second",
    });
    t.translator.handle("item/reasoning/summaryPartAdded", {
      itemId: "r",
      summaryIndex: 0,
    });
    t.translator.handle("item/reasoning/summaryTextDelta", {
      itemId: "r",
      summaryIndex: 0,
      delta: "First",
    });
    t.item({
      type: "reasoning",
      id: "r",
      summary: ["First", "Second corrected"],
      content: [],
    });
    t.item({
      type: "reasoning",
      id: "snapshot",
      summary: ["Snapshot only"],
      content: [],
    });
    t.item({ type: "reasoning", id: "encrypted", summary: [], content: [] });
    expect(
      t
        .messages()
        .filter((m) => m.kind === "text")
        .map((m) => m.text),
    ).toEqual(["First\n\nSecond corrected", "Snapshot only"]);
  });

  it("recovers completion-only tools once and ignores stale starts and output", () => {
    const t = transcript();
    const item = {
      type: "commandExecution",
      id: "cmd",
      command: "pwd",
      cwd: "/workspace",
      exitCode: 0,
      aggregatedOutput: "/workspace",
    };
    t.item(item);
    t.item(item);
    t.item({ ...item, status: "inProgress" }, false);
    t.translator.handle("item/commandExecution/outputDelta", {
      itemId: "cmd",
      delta: "stale",
    });
    expect(t.messages()).toEqual([
      expect.objectContaining({
        status: "completed",
        rawInput: expect.objectContaining({ cwd: "/workspace" }),
        rawOutput: expect.objectContaining({ output: "/workspace" }),
      }),
    ]);
  });

  it("retains final file changes even when the started snapshot is empty", () => {
    const t = transcript();
    t.item({ type: "fileChange", id: "edit", changes: [] }, false);
    const changes = [
      {
        path: "/workspace/a.ts",
        kind: { type: "update", move_path: "/workspace/b.ts" },
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    t.item({ type: "fileChange", id: "edit", changes, status: "completed" });
    expect(t.messages()[0]).toMatchObject({
      rawInput: { changes },
      status: "completed",
    });
  });

  it.each([
    { type: "commandExecution", command: "pwd", status: "declined" },
    { type: "fileChange", changes: [], status: "declined" },
    { type: "dynamicToolCall", tool: "check", status: "failed", success: null },
    {
      type: "imageGeneration",
      status: "failed",
      result: "",
      failure: { message: "Generation failed" },
    },
  ])("preserves failure for $type ($status)", (value) => {
    const t = transcript();
    t.item({ ...value, id: "tool" }, false);
    t.item({ ...value, id: "tool" });
    expect(t.messages()[0]).toMatchObject({ status: "failed" });
  });

  it.each([
    { type: "search", queries: ["first query", "second query"] },
    { type: "open_page", url: "https://example.com/guide" },
    {
      type: "find_in_page",
      url: "https://example.com/guide",
      pattern: "Example",
    },
  ])("retains web action $type and its results", (action) => {
    const t = transcript();
    t.item({ type: "webSearch", id: "web", query: "" }, false);
    const results = [
      {
        title: "Example",
        url: "https://example.com/guide",
        snippet: "Useful result",
      },
    ];
    t.item({ type: "webSearch", id: "web", query: "", action, results });
    expect(t.messages()[0]).toMatchObject({
      rawInput: { action },
      rawOutput: { results },
    });
  });

  it("preserves full read paths, cwd, command actions and exit information", () => {
    const t = transcript();
    t.item({
      type: "commandExecution",
      id: "read",
      command: "cat src/a.ts",
      cwd: "/workspace",
      commandActions: [
        { type: "read", name: "a.ts", path: "/workspace/src/a.ts" },
      ],
      exitCode: 1,
      aggregatedOutput: "Permission denied",
    });
    expect(t.messages()[0]).toMatchObject({
      toolKind: "read",
      rawInput: {
        file_path: "/workspace/src/a.ts",
        cwd: "/workspace",
        command: "cat src/a.ts",
      },
      rawOutput: { exitCode: 1, output: "Permission denied" },
      status: "failed",
    });
  });

  it("preserves image metadata without exposing the binary as raw text", () => {
    const t = transcript();
    t.item({
      type: "imageGeneration",
      id: "image",
      status: "completed",
      revisedPrompt: "A landscape",
      result: "aGVsbG8=",
      savedPath: "/workspace/output.png",
    });
    expect(t.messages()[0]).toMatchObject({
      status: "completed",
      rawInput: { revisedPrompt: "A landscape" },
      rawOutput: { savedPath: "/workspace/output.png" },
      content: [
        {
          type: "content",
          content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        },
      ],
    });
    const image = t.messages()[0];
    expect(
      JSON.stringify(image.kind === "tool" && image.rawOutput),
    ).not.toContain("aGVsbG8=");
  });
});
