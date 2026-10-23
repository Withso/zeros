import { nativeId } from "../fake-query";

type Frame = Record<string, unknown>;
const system = (subtype: string, fields: Frame = {}): Frame => ({ type: "system", subtype, session_id: nativeId, ...fields });
const assistant = (id: string, content: unknown[], fields: Frame = {}): Frame => ({ type: "assistant", uuid: `frame-${id}`, session_id: nativeId, message: { id, role: "assistant", model: "claude-sonnet-4-6", content }, ...fields });
const tool = (id: string, name: string, input: Frame): Frame => ({ type: "tool_use", id, name, input });
const output = (id: string, content: unknown, fields: Frame = {}): Frame => ({ type: "user", uuid: `result-${id}`, session_id: nativeId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, ...fields });
const result = (fields: Frame = {}): Frame => ({ type: "result", subtype: "success", session_id: nativeId, uuid: "root-result", result: "", user_message_uuid: "@input", ...fields });
const stream = (event: Frame): Frame => ({ type: "stream_event", session_id: nativeId, event });
const text = (text: string): Frame => ({ type: "text", text });
const init = system("init", { model: "claude-sonnet-4-6", tools: ["Read", "Bash", "Edit"], slash_commands: [] });

/** Synthetic native SDK/CLI frames; no credentials, user data or model calls. */
export const streams: Array<{ name: string; frames: Frame[] }> = [
  { name: "streamed prose and thinking reconcile with authoritative content and usage", frames: [init,
    stream({ type: "message_start", message: { id: "answer", role: "assistant", content: [] } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the fixture." } }),
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "content_block_start", index: 1, content_block: text("") }),
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "First draft" } }),
    stream({ type: "content_block_stop", index: 1 }), stream({ type: "message_stop" }),
    assistant("answer", [{ type: "thinking", thinking: "Check the fixture." }, text("Final answer.")]),
    result({ result: "Final answer.", total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 2, costUSD: 0.02 } } }),
  ] },
  { name: "native tool identities, file edits, structured results and attachments", frames: [init,
    assistant("read", [text("Reading the file."), tool("read-one", "Read", { file_path: "/fixture/file.ts" })]),
    output("read-one", "export const value = 1;"),
    assistant("edit", [tool("edit-one", "Edit", { file_path: "/fixture/file.ts", old_string: "1", new_string: "2" }), tool("shell", "Bash", { command: "git diff", description: "Inspect the change" })]),
    output("edit-one", "File updated", { tool_use_result: { filePath: "/fixture/file.ts", oldString: "1", newString: "2" } }),
    output("shell", "diff --git a/file.ts b/file.ts\n-1\n+2"),
    assistant("mcp", [tool("mcp-one", "mcp__fixture__image", { path: "fixture.png" })]),
    output("mcp-one", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zml4dHVyZQ==" } }, text("Image result")]),
    result({ result: "Updated the fixture." }),
  ] },
  { name: "nested agents preserve child tools and parent completion", frames: [init,
    assistant("launch", [tool("parent", "Agent", { description: "Check fixtures", prompt: "Inspect tests", subagent_type: "Explore" })]),
    system("task_started", { task_id: "child-task", tool_use_id: "parent", task_type: "local_agent", description: "Check fixtures" }),
    assistant("child", [text("Inspecting tests."), tool("child-read", "Read", { file_path: "/fixture/test.ts" })], { parent_tool_use_id: "parent" }),
    output("child-read", "fixture body", { parent_tool_use_id: "parent" }),
    result({ uuid: "child-result", parent_tool_use_id: "parent", result: "Child report", user_message_uuid: undefined }),
    system("task_notification", { task_id: "child-task", status: "completed", summary: "Fixtures checked" }),
    output("parent", "Fixtures checked", { tool_use_result: { status: "completed", agentId: "child-task", content: [text("Fixtures checked")] } }),
    result({ result: "Checks passed." }),
  ] },
  { name: "background work continues after completion and repeated init retains its clock", frames: [init,
    assistant("shell-start", [tool("shell-bg", "Bash", { command: "pnpm test", run_in_background: true, description: "Run tests" })]),
    system("task_started", { task_id: "tests", tool_use_id: "shell-bg", task_type: "shell", description: "Run tests", is_backgrounded: true }),
    system("background_tasks_changed", { tasks: [{ task_id: "tests", task_type: "shell", description: "Run tests" }] }),
    output("shell-bg", "Tests running", { tool_use_result: { backgroundTaskId: "tests" } }),
    result({ result: "Tests are running." }), init,
    system("task_progress", { task_id: "tests", summary: "Checking fixtures", last_tool_name: "Bash", usage: { duration_ms: 2000 } }),
    system("task_notification", { task_id: "tests", status: "completed", summary: "All tests passed" }),
    assistant("report", [text("All tests passed.")]),
    result({ uuid: "background-result", result: "All tests passed.", origin: { kind: "task_notification" }, user_message_uuid: undefined }),
  ] },
  { name: "compaction, retry feedback and unknown failed tools remain inspectable", frames: [init,
    system("status", { status: "compacting" }),
    system("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 120_000 } }),
    system("api_retry", { attempt: 1, max_retries: 3, retry_delay_ms: 1000, error: "Temporary overload", error_status: 529 }),
    assistant("unknown", [tool("unknown-tool", "FutureTool", { query: "fixture" })]),
    { ...output("unknown-tool", "Cannot complete this operation"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-tool", content: "Cannot complete this operation", is_error: true }] } },
    result({ terminal_reason: "max_tokens" }),
  ] },
  { name: "superseded native frames retract without merging different calls", frames: [init,
    assistant("old", [text("Old response"), tool("first-read", "Read", { file_path: "/fixture/same.ts" })]),
    output("first-read", "old content"),
    assistant("replacement", [text("Corrected response"), tool("second-read", "Read", { file_path: "/fixture/same.ts" })], { supersedes: ["frame-old"] }),
    output("second-read", "new content"), result({ result: "Corrected response" }),
  ] },
  { name: "native authentication failure produces the same terminal rows", frames: [init,
    { type: "assistant", uuid: "synthetic-auth", error: "authentication_failed", message: { id: "auth", role: "assistant", model: "<synthetic>", content: [text("401 authentication expired")] } },
    result({ subtype: "error_during_execution", is_error: true, errors: ["401 authentication expired"] }),
  ] },
];
