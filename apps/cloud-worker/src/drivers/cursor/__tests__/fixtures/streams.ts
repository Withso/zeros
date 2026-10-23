export type Delivery = { kind: "delta" | "step" | "message"; value: Record<string, unknown> };
const delta = (value: Record<string, unknown>): Delivery => ({ kind: "delta", value });
const step = (type: string, message: unknown): Delivery => ({ kind: "step", value: { type, message } });
const message = (value: Record<string, unknown>): Delivery => ({ kind: "message", value });
const assistant = (text: string) => message({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (id: string, name = "shell", result: unknown = { status: "success", value: { exitCode: 0, stdout: "ok" } }) => message({
  type: "tool_call", call_id: id, name, status: "completed", args: { command: "check" }, result,
});
const task = (id: string) => ({ type: "task", args: { agentId: `child-${id}`, description: `Inspect ${id}` } });
const child = (id: string, taskUpdate: unknown) => delta({ type: "tool-call-delta", callId: id, taskUpdate });
const finishTask = (id: string) => delta({ type: "tool-call-completed", callId: id, toolCall: {
  ...task(id), result: { status: "success", value: { agentId: `child-${id}`, isBackground: false } },
} });
interface Fixture { name: string; before?: Delivery[]; frames: Delivery[]; result: { status?: string; result?: string }; checkpoint?: boolean }

/** Synthetic native records mirror SDK 1.0.37 callback/step/stream shapes.
 * Every fixture crosses a real host process before the canonical row fold. */
export const streams: Fixture[] = [
  {
    name: "callbacks before send, buffered mirrors and authoritative final text",
    before: [delta({ type: "text-delta", text: "Working" }), step("assistantMessage", { text: "Working" })],
    frames: [
      delta({ type: "tool-call-started", callId: "call", toolCall: { type: "shell", args: { command: "check" } } }),
      step("toolCall", { type: "shell", args: { command: "check" }, result: { status: "success", value: { exitCode: 0, stdout: "ok" } } }),
      delta({ type: "tool-call-completed", callId: "call", toolCall: { type: "shell", args: { command: "check" }, result: { status: "success", value: { exitCode: 0, stdout: "ok" } } } }),
      delta({ type: "thinking-delta", text: "Thinking" }), step("thinkingMessage", { text: "Thinking" }),
      delta({ type: "text-delta", text: "Final " }), delta({ type: "text-delta", text: "answer" }), step("assistantMessage", { text: "Final answer" }),
      message({ type: "request", request_id: "sdk-request" }), assistant("Working"), tool("call"),
      message({ type: "thinking", text: "Thinking" }), message({ type: "thinking", text: "", thinking_duration_ms: 100 }), assistant("Final "), assistant("answer"),
      message({ type: "status", status: "FINISHED" }),
    ], result: { result: "Final answer" },
  },
  {
    name: "distinct identical calls, replay, foreign run rejection and final answer correction",
    frames: [assistant("Done"), tool("one"), tool("two"), tool("two"),
      message({ ...assistant("Foreign").value, agent_id: "other", run_id: "run-1" }),
      message({ ...assistant("Stale").value, agent_id: "native-agent", run_id: "old" }),
      assistant("Partial answer"), tool("late")], result: { result: "Corrected complete answer" },
  },
  {
    name: "failed shell, native edit diff and image result",
    frames: [
      tool("failed", "shell", { status: "success", value: { exitCode: 1, stderr: "Permission denied" } }),
      message({ type: "tool_call", call_id: "edit", name: "edit", status: "completed", args: { path: "example.ts", oldString: "before", newString: "after" }, result: { success: { path: "example.ts", diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after" } } }),
      message({ type: "tool_call", call_id: "image", name: "read", status: "completed", args: { path: "example.png" }, result: { status: "success", value: { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] } } }),
    ], result: { result: "Edit applied; shell failed." },
  },
  {
    name: "interleaved native children retain separate ownership",
    frames: [
      delta({ type: "tool-call-started", callId: "a", toolCall: task("a") }), delta({ type: "tool-call-started", callId: "b", toolCall: task("b") }),
      child("a", { type: "thinking-delta", text: "Inspect A" }),
      child("a", { type: "tool-call-started", callId: "same", toolCall: { type: "read", args: { path: "a.md" } } }),
      child("b", { type: "tool-call-started", callId: "same", toolCall: { type: "read", args: { path: "b.md" } } }),
      child("a", { type: "tool-call-completed", callId: "same", toolCall: { type: "read", args: { path: "a.md" }, result: { status: "error", error: { message: "Permission denied" } } } }),
      child("b", { type: "text-delta", text: "Child B report" }), finishTask("b"),
      child("a", { type: "text-delta", text: "Child A report" }), finishTask("a"),
    ], result: { result: "Both children finished." },
  },
  {
    name: "owned child checkpoint restores tools and report at turn end", checkpoint: true,
    frames: [message({ type: "tool_call", call_id: "task", name: "task", status: "running", args: { agentId: "child-file", description: "Inspect files" } }),
      message({ type: "tool_call", call_id: "task", name: "task", status: "completed", result: { status: "success", value: { agentId: "child-file", finalMessage: "Checkpoint report" } } })],
    result: { result: "Child complete." },
  },
  {
    name: "missing child checkpoint preserves a visible capture notice",
    frames: [message({ type: "tool_call", call_id: "task", name: "task", status: "completed", args: { agentId: "missing", description: "Inspect files" }, result: { status: "success", value: { agentId: "missing", finalMessage: "Native report" } } })],
    result: { result: "Native result retained." },
  },
  {
    name: "failed native status retains the transcript without inventing success",
    frames: [assistant("Partial output"), message({ type: "status", status: "ERROR", message: "Native error" })], result: { status: "error" },
  },
];
