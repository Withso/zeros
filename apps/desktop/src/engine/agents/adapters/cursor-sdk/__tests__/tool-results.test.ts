import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import { parseSubagentTranscript } from "../subagent-transcript";
import type { CursorSdkTranslatorOptions } from "../translator";

function capture(options: Partial<CursorSdkTranslatorOptions> = {}) {
  let messages: AgentMessage[] = [];
  const t = new CursorSdkTranslator({
    ...options,
    sessionId: "s1",
    emit: (event) => {
      messages = applyUpdate(messages, event);
    },
  });
  return {
    t,
    tools: () => messages.filter((m) => m.kind === "tool"),
    messages: () => messages,
  };
}

const jsonl = (...records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join("\n");
const call = (
  id: string | undefined,
  name = "Read",
  input: unknown = { path: "file.ts" },
) => ({
  role: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, content: unknown, is_error = false) => ({
  role: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
  },
});
const toolSteps = (text: string) =>
  parseSubagentTranscript(text).steps.filter((s) => s.type === "tool");
const textContent = (text: string) => [
  { type: "content", content: { type: "text", text } },
];

describe("Cursor native tool outcomes", () => {
  it.each(["stream", "delta", "step"] as const)(
    "uses shell exit status and MCP isError with the %s source",
    (source) => {
      for (const [name, nativeResult, expected] of [
        [
          "shell",
          {
            status: "success",
            value: {
              exitCode: 1,
              stdout: "Started",
              stderr: "Permission denied",
            },
          },
          "failed",
        ],
        [
          "shellToolCall",
          { success: { exitCode: 2, stderr: "Bad arguments" } },
          "failed",
        ],
        [
          "shell",
          {
            result: {
              case: "success",
              value: { exitCode: 1, stderr: "Failed" },
            },
          },
          "failed",
        ],
        [
          "shell",
          {
            status: "success",
            value: { exitCode: 0, signal: "SIGTERM", stderr: "Terminated" },
          },
          "failed",
        ],
        [
          "shell",
          {
            status: "success",
            value: { exitCode: 0, stderr: "warning: harmless" },
          },
          "completed",
        ],
        [
          "shell",
          { status: "success", value: { stdout: "Started" } },
          "pending",
        ],
        ["shell", { status: "success", value: { exitCode: "1" } }, "pending"],
        [
          "mcp",
          {
            status: "success",
            value: {
              isError: true,
              content: [{ text: { text: "Permission denied" } }],
            },
          },
          "failed",
        ],
        [
          "mcp",
          {
            status: "success",
            value: {
              isError: false,
              content: [{ text: { text: "The log says error" } }],
            },
          },
          "completed",
        ],
        [
          "read",
          { status: "success", error: null, value: { content: "ok" } },
          "completed",
        ],
      ] as const) {
        const env = capture();
        const tool = {
          type: name,
          args: { command: "check", path: "file.ts" },
          result: nativeResult,
        };
        if (source === "stream")
          env.t.feed({
            type: "tool_call",
            call_id: "tool",
            name,
            args: tool.args,
            result: nativeResult,
            status: "completed",
          });
        else if (source === "delta")
          env.t.feedDelta({
            type: "tool-call-completed",
            callId: "tool",
            toolCall: tool,
          });
        else env.t.feedStep({ type: "toolCall", message: tool });
        expect(
          env.tools(),
          `${source}: ${JSON.stringify(nativeResult)}`,
        ).toEqual([
          expect.objectContaining({
            status: expected,
            rawOutput: expect.anything(),
          }),
        ]);
      }
    },
  );

  it("keeps stdout and stderr alongside a failed main command", () => {
    const env = capture();
    env.t.feed({
      type: "tool_call",
      call_id: "shell",
      name: "shell",
      status: "running",
      args: { command: "check" },
    });
    env.t.feed({
      type: "tool_call",
      call_id: "shell",
      name: "shell",
      status: "completed",
      result: {
        status: "success",
        value: { exitCode: 1, stdout: "Started", stderr: "Permission denied" },
      },
    });
    expect(env.tools()).toEqual([
      expect.objectContaining({
        status: "failed",
        rawInput: { command: "check" },
        rawOutput: {
          status: "success",
          value: {
            exitCode: 1,
            stdout: "Started",
            stderr: "Permission denied",
          },
        },
        content: textContent("Started\nPermission denied"),
      }),
    ]);
  });

  it("does not complete a callback step that has no result", () => {
    const env = capture();
    env.t.feedStep({
      type: "toolCall",
      message: { type: "read", args: { path: "file.ts" } },
    });
    expect(env.tools()[0].status).toBe("pending");
  });

  it("uses the original tool name when completion omits it and keeps one row on replay", () => {
    const env = capture();
    env.t.feed({
      type: "tool_call",
      call_id: "shell",
      name: "shell",
      status: "running",
      args: { command: "check" },
    });
    const end = {
      type: "tool_call",
      call_id: "shell",
      status: "completed",
      result: {
        status: "success",
        value: { exitCode: 1, stderr: "Permission denied" },
      },
    };
    env.t.feed(end);
    env.t.feed(end);
    env.t.feed({
      type: "tool_call",
      call_id: "shell",
      name: "shell",
      status: "running",
    });
    expect(env.tools()).toEqual([
      expect.objectContaining({
        status: "failed",
        rawInput: { command: "check" },
      }),
    ]);
  });

  it("leaves interrupted main tools unresolved on final flush", () => {
    const env = capture();
    env.t.feed({
      type: "tool_call",
      call_id: "read",
      name: "read",
      status: "running",
    });
    env.t.flushSubagents();
    expect(env.tools()[0]).toMatchObject({
      status: "pending",
      rawOutput: { _zerosToolCompletion: "unreported" },
    });
    const confirmed = env.messages();
    env.t.flushSubagents();
    expect(env.messages()).toBe(confirmed);
  });

  it("ignores partial callbacks after the same native call failed", () => {
    const env = capture();
    const toolCall = {
      type: "shell",
      args: { command: "check" },
      result: { status: "success", value: { exitCode: 1, stderr: "Denied" } },
    };
    env.t.feedDelta({ type: "tool-call-completed", callId: "shell", toolCall });
    env.t.feedDelta({
      type: "partial-tool-call",
      callId: "shell",
      toolCall: { type: "shell", args: { command: "check" } },
    });
    expect(env.tools()).toEqual([
      expect.objectContaining({
        status: "failed",
        content: textContent("Denied"),
      }),
    ]);
  });
});

describe("Cursor child result correlation", () => {
  it("retains errors by native ID with interleaved and out-of-order results", () => {
    const steps = toolSteps(
      jsonl(
        result("second", [{ type: "text", text: "Permission denied" }], true),
        call("first"),
        call("second"),
        result("first", "file contents"),
        result("unrelated", "must not attach", true),
      ),
    );
    expect(steps).toEqual([
      expect.objectContaining({
        nativeToolCallId: "first",
        status: "completed",
        rawOutput: "file contents",
        content: textContent("file contents"),
      }),
      expect.objectContaining({
        nativeToolCallId: "second",
        status: "failed",
        content: textContent("Permission denied"),
      }),
    ]);
  });

  it("leaves missing IDs and missing results unresolved, even after the final answer", () => {
    const steps = toolSteps(
      jsonl(call(undefined), call("open"), {
        role: "assistant",
        message: { content: [{ type: "text", text: "Done." }] },
      }),
    );
    expect(steps.map((s) => s.status)).toEqual(["pending", "pending"]);
  });

  it("deduplicates replayed calls and results without erasing an error", () => {
    const steps = toolSteps(
      jsonl(
        call("read"),
        result("read", "Permission denied", true),
        call("read"),
        result("read", "Permission denied", true),
      ),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      status: "failed",
      content: textContent("Permission denied"),
    });
  });

  it("reads typed user envelopes and ignores malformed/truncated records", () => {
    const input =
      jsonl(call("read"), {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "read",
              is_error: true,
              content: "Permission denied",
            },
          ],
        },
      }) + '\n{"role":"user","message":';
    expect(toolSteps(input)[0]).toMatchObject({
      status: "failed",
      rawOutput: "Permission denied",
    });
  });

  it("accepts empty successful results without inventing errors from output text", () => {
    const steps = toolSteps(
      jsonl(
        call("empty"),
        call("text"),
        result("empty", ""),
        result("text", "error: an example in a document"),
      ),
    );
    expect(steps.map((s) => s.status)).toEqual(["completed", "completed"]);
  });

  it("honors structured shell errors inside a child result", () => {
    expect(
      toolSteps(
        jsonl(
          call("shell", "Shell", { command: "check" }),
          result("shell", {
            status: "success",
            value: {
              exitCode: 1,
              stdout: "Started",
              stderr: "Permission denied",
            },
          }),
        ),
      )[0],
    ).toMatchObject({
      status: "failed",
      content: textContent("Started\nPermission denied"),
    });
  });

  it("does not promote earlier narration to a final answer while tools remain", () => {
    const parsed = parseSubagentTranscript(
      jsonl(
        {
          role: "assistant",
          message: {
            content: [{ type: "text", text: "I will read the file." }],
          },
        },
        call("read"),
      ),
    );
    expect(parsed.finalText).toBe("");
    expect(parsed.steps[0]).toEqual({
      type: "text",
      text: "I will read the file.",
    });
  });

  it("does not replace a structured child failure with a replayed success", () => {
    const steps = toolSteps(
      jsonl(
        call("shell", "Shell"),
        result("shell", {
          status: "success",
          value: { exitCode: 1, stderr: "Denied" },
        }),
        result("shell", { status: "success", value: { exitCode: 0 } }),
      ),
    );
    expect(steps[0]).toMatchObject({
      status: "failed",
      content: textContent("Denied"),
    });
  });
});

describe("Cursor child refresh and fallback results", () => {
  it("keeps fallback narration before an unresolved call out of the final report", () => {
    const env = capture();
    env.t.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: {
          conversationSteps: [
            {
              type: "assistantMessage",
              message: { text: "I will inspect the file." },
            },
            {
              type: "toolCall",
              message: { type: "read", args: { path: "file.ts" } },
            },
          ],
        },
      },
    });
    env.t.flushSubagents();
    expect(env.tools()[0].content).toBeUndefined();
    expect(env.messages()).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: "I will inspect the file.",
      }),
    );
  });

  it("keeps a child shell result unresolved when its structured wrapper omitted the exit code", () => {
    const steps = toolSteps(
      jsonl(
        call("shell", "Shell"),
        result("shell", { status: "success", value: { stdout: "Started" } }),
      ),
    );
    expect(steps[0]).toMatchObject({
      status: "pending",
      content: textContent("Started"),
    });
  });

  function live() {
    let snapshot = jsonl(call("read"));
    const env = capture({
      loadSubagentTranscript: () => parseSubagentTranscript(snapshot),
    });
    env.t.feed({
      type: "tool_call",
      call_id: "task",
      name: "task",
      status: "running",
      args: { agentId: "child" },
    });
    return {
      ...env,
      set: (next: string) => {
        snapshot = next;
      },
    };
  }

  it.each(["poll", "flush"] as const)(
    "updates an existing child when the error arrives at %s",
    (phase) => {
      const env = live();
      env.t.pollSubagents();
      const original = env.tools()[1];
      expect(original.status).toBe("pending");
      env.set(jsonl(call("read"), result("read", "Permission denied", true)));
      if (phase === "poll") env.t.pollSubagents();
      else env.t.flushSubagents();
      expect(env.tools()).toHaveLength(2);
      expect(env.tools()[1]).toMatchObject({
        toolCallId: original.toolCallId,
        parentToolId: original.parentToolId,
        status: "failed",
        content: textContent("Permission denied"),
      });
      const confirmed = env.messages();
      env.t.pollSubagents();
      expect(env.messages()).toBe(confirmed);
    },
  );

  it("retains a confirmed result if a later read is a partial prefix", () => {
    const env = live();
    env.set(jsonl(call("read"), result("read", "Permission denied", true)));
    env.t.pollSubagents();
    const confirmed = env.tools()[1];
    env.set(jsonl(call("read")));
    env.t.pollSubagents();
    env.t.flushSubagents();
    expect(env.tools()[1]).toBe(confirmed);
    expect(env.tools()[1]).toMatchObject({
      status: "failed",
      rawOutput: "Permission denied",
    });
  });

  it("marks uncaptured completion at final flush without leaving a running child", () => {
    const env = live();
    env.t.pollSubagents();
    env.t.flushSubagents();
    expect(env.tools()[1]).toMatchObject({
      status: "pending",
      rawOutput: { _zerosToolCompletion: "unreported" },
    });
    const confirmed = env.messages();
    env.t.flushSubagents();
    env.t.pollSubagents();
    expect(env.messages()).toBe(confirmed);
  });

  it("isolates identical native tool IDs between concurrent children", () => {
    const env = capture({
      loadSubagentTranscript: (id) =>
        parseSubagentTranscript(
          jsonl(call("same"), result("same", id, id === "bad")),
        ),
    });
    for (const id of ["bad", "good"])
      env.t.feed({
        type: "tool_call",
        call_id: id,
        name: "task",
        status: "running",
        args: { agentId: id },
      });
    env.t.pollSubagents();
    const [bad, good] = env.tools().filter((t) => t.parentToolId);
    expect(bad).toMatchObject({
      status: "failed",
      content: textContent("bad"),
    });
    expect(good).toMatchObject({
      status: "completed",
      content: textContent("good"),
    });
    expect(bad.toolCallId).not.toBe(good.toolCallId);
    expect(bad.parentToolId).not.toBe(good.parentToolId);
  });

  it.each(["read", "edit", "write", "delete", "mcp", "futureTool"])(
    "retains fallback %s error output and leaves its missing result pending",
    (name) => {
      const env = capture();
      env.t.feed({
        type: "tool_call",
        call_id: "task",
        name: "task",
        status: "completed",
        result: {
          status: "success",
          value: {
            conversationSteps: [
              {
                type: "toolCall",
                message: {
                  type: name,
                  args: { path: "file.ts" },
                  result: {
                    status: "error",
                    error: { message: "Permission denied" },
                  },
                },
              },
              {
                type: "toolCall",
                message: { type: name, args: { path: "other.ts" } },
              },
            ],
          },
        },
      });
      env.t.flushSubagents();
      const [failed, pending] = env.tools().filter((t) => t.parentToolId);
      expect(failed).toMatchObject({
        status: "failed",
        rawOutput: { status: "error", error: { message: "Permission denied" } },
        content: textContent("Permission denied"),
      });
      expect(pending.status).toBe("pending");
      expect(env.tools()[0].status).toBe("completed"); // A child failure need not fail its parent.
    },
  );
});
