// Synthetic recordings of the 0.164.0 native wire, extending the Local adapter
// regressions at 4baf69ec. No private conversation or provider access is used.
import type { ImageGenerationItem } from "../../native-types";
export interface NativeFrame {
  method: string;
  params: Record<string, unknown>;
}

const item = (phase: "started" | "completed", value: Record<string, unknown>): NativeFrame => ({
  method: `item/${phase}`,
  params: { threadId: "native-chat", turnId: "native-turn", item: value },
});
const notice = (method: string, params: Record<string, unknown>): NativeFrame => ({
  method,
  params: { threadId: "native-chat", turnId: "native-turn", ...params },
});
const completed = (status = "completed", extra: Record<string, unknown> = {}): NativeFrame =>
  notice("turn/completed", { turn: { id: "native-turn", status, ...extra } });

export const streams: Array<{ name: string; frames: NativeFrame[] }> = [
  ...([
    { id: "inline-image", status: "completed", revisedPrompt: "A landscape", failure: null, result: "aGVsbG8=", savedPath: "/repo/output.png" },
    { id: "stored-image", status: "completed", revisedPrompt: "A landscape", failure: null, fileId: "file-generated-image", savedPath: "/repo/output.png" },
  ] satisfies ImageGenerationItem[]).map((image) => ({
    name: `image generation ${image.id} completion and replay`,
    frames: [
      item("started", { type: "imageGeneration", ...image }),
      item("completed", { type: "imageGeneration", ...image }),
      completed(),
      item("completed", { type: "imageGeneration", ...image }),
    ],
  })),
  {
    name: "overlapping read calls keep their own status and start order",
    frames: [
      item("started", { type: "dynamicToolCall", id: "first", namespace: "skills", tool: "read", arguments: { name: "guide" }, status: "inProgress" }),
      item("started", { type: "dynamicToolCall", id: "second", namespace: "skills", tool: "read", arguments: { name: "guide" }, status: "inProgress" }),
      item("completed", { type: "dynamicToolCall", id: "second", namespace: "skills", tool: "read", status: "completed", success: true, contentItems: [{ type: "inputText", text: "Second result" }] }),
      item("completed", { type: "dynamicToolCall", id: "first", namespace: "skills", tool: "read", status: "failed", success: false, contentItems: [{ type: "inputText", text: "First failed" }] }),
      completed(),
      item("started", { type: "dynamicToolCall", id: "first", namespace: "skills", tool: "read", status: "inProgress" }),
      item("started", { type: "dynamicToolCall", id: "second", namespace: "skills", tool: "read", status: "inProgress" }),
    ],
  },
  {
    name: "prose, phases, correction, reasoning parts and completion replay",
    frames: [
      item("started", { type: "reasoning", id: "thought", summary: ["Check"] }),
      notice("item/reasoning/summaryTextDelta", { itemId: "thought", summaryIndex: 0, delta: " the source" }),
      notice("item/reasoning/textDelta", { itemId: "thought", contentIndex: 0, delta: "Private alternate channel" }),
      item("completed", { type: "reasoning", id: "thought", summary: ["Check the source", "Verify"] }),
      item("started", { type: "agentMessage", id: "prose", text: "", phase: "commentary" }),
      notice("item/agentMessage/delta", { itemId: "prose", delta: "Working" }),
      item("completed", { type: "agentMessage", id: "prose", text: "Worked", phase: "final_answer" }),
      item("completed", { type: "agentMessage", id: "prose", text: "Worked", phase: "final_answer" }),
      notice("item/agentMessage/delta", { itemId: "prose", delta: " stale" }),
      completed(),
    ],
  },
  {
    name: "shell output increments, snapshots, completion-only reads and failures",
    frames: [
      item("started", { type: "commandExecution", id: "exec", command: "pwd" }),
      notice("item/commandExecution/outputDelta", { itemId: "exec", delta: "/repo" }),
      notice("item/commandExecution/outputDelta", { itemId: "exec", output: "/repo\n" }),
      notice("item/commandExecution/terminalInteraction", { itemId: "exec", delta: "stdin must not be output" }),
      item("completed", { type: "commandExecution", id: "exec", command: "pwd", status: "completed", exitCode: 0 }),
      item("completed", { type: "commandExecution", id: "read", command: "cat README.md", status: "completed", exitCode: 0, aggregatedOutput: "A readme", commandActions: [{ type: "read", path: "README.md" }] }),
      item("completed", { type: "commandExecution", id: "failure", command: "false", status: "failed", exitCode: 1, aggregatedOutput: "Failure remains visible" }),
      item("started", { type: "commandExecution", id: "failure", command: "false" }),
      completed(),
    ],
  },
  {
    name: "file patches, MCP structured output and dynamic tools",
    frames: [
      item("started", { type: "fileChange", id: "edit", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "-old\n+new" }] }),
      notice("item/fileChange/patchUpdated", { itemId: "edit", changes: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] }),
      notice("item/fileChange/outputDelta", { itemId: "edit", delta: "Applied" }),
      item("completed", { type: "fileChange", id: "edit", status: "completed", changes: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] }),
      notice("item/mcpToolCall/progress", { itemId: "mcp", message: "Loading" }),
      item("started", { type: "mcpToolCall", id: "mcp", server: "catalog", tool: "search", arguments: { query: "guide" } }),
      item("completed", { type: "mcpToolCall", id: "mcp", server: "catalog", tool: "search", status: "completed", result: { content: [{ type: "text", text: "Guide" }, { type: "resource_link", uri: "https://example.com/guide", name: "Guide" }], structuredContent: { count: 1 }, _meta: { private: "omit" } } }),
      item("completed", { type: "dynamicToolCall", id: "dynamic", namespace: "tools", tool: "lookup", arguments: { query: "item" }, contentItems: [{ type: "inputText", text: "Result" }], success: true, status: "completed" }),
      completed(),
    ],
  },
  {
    name: "interrupted sleep is unreported and late native completion repairs it",
    frames: [
      item("started", { type: "sleep", id: "sleep", durationMs: 1000 }),
      completed("interrupted"),
      item("completed", { type: "sleep", id: "sleep", durationMs: 1000 }),
    ],
  },
  {
    name: "authoritative full turn restores missing items; summaries cannot",
    frames: [
      completed("completed", { itemsView: "summary", items: [{ type: "agentMessage", id: "not-authoritative", text: "Ignore" }] }),
      completed("completed", { itemsView: "full", items: [
        { type: "commandExecution", id: "unsettled", command: "sleep 10", status: "inProgress" },
        { type: "commandExecution", id: "finished", command: "pwd", status: "completed", exitCode: 0, aggregatedOutput: "/repo" },
        { type: "agentMessage", id: "answer", text: "Finished", phase: "final_answer" },
      ] }),
    ],
  },
  {
    name: "retry burst, warning, terminal error and context usage",
    frames: [
      notice("error", { error: { message: "Temporary connection failure", codexErrorInfo: "responseStreamDisconnected" }, willRetry: true }),
      notice("error", { error: { message: "Temporary connection failure", codexErrorInfo: "responseStreamDisconnected" }, willRetry: true }),
      notice("warning", { message: "A native warning" }),
      notice("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 100, totalTokens: 180 }, last: { inputTokens: 150, outputTokens: 30, totalTokens: 180 }, modelContextWindow: 1000 } }),
      completed("failed", { error: { message: "Context window exceeded", codexErrorInfo: "contextWindowExceeded" } }),
    ],
  },
  {
    name: "review, compaction, web tools, unknown records and no-op transport",
    frames: [
      item("started", { type: "contextCompaction", id: "compact" }),
      item("completed", { type: "contextCompaction", id: "compact" }),
      item("completed", { type: "webSearch", id: "search", query: "guide", action: { type: "search", query: "guide" } }),
      item("completed", { type: "imageView", id: "image", path: "/repo/image.png" }),
      item("completed", { type: "functionCallOutput", id: "unknown", output: "Preserved" }),
      notice("thread/environment/connected", { environmentId: "ignored" }),
      notice("turn/diff/updated", { diff: "aggregate is not a second edit" }),
      item("completed", { type: "exitedReviewMode", id: "review", review: "No findings" }),
      completed(),
    ],
  },
  {
    name: "agent group identity, lifecycle and metadata remain native",
    frames: [
      item("started", { type: "subAgentActivity", id: "child-start", agentThreadId: "child", kind: "started", agentPath: "/root/reviewer", model: "model-a" }),
      item("completed", { type: "subAgentActivity", id: "child-start", agentThreadId: "child", kind: "started", agentPath: "/root/reviewer", model: "model-a" }),
      item("completed", { type: "subAgentActivity", id: "child-end", agentThreadId: "child", kind: "completed", agentPath: "/root/reviewer" }),
      item("started", { type: "subAgentActivity", id: "child-start", agentThreadId: "child", kind: "started", agentPath: "/root/reviewer" }),
      completed(),
    ],
  },
];
