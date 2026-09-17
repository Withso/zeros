import { describe, expect, it } from "vitest";
import { hasClaudeModelContent } from "../first-content";

describe("Claude content-bearing frames", () => {
  it.each([
    null,
    {},
    { type: "system", subtype: "thinking_tokens", thinking_tokens: 200 },
    { type: "result", result: "Done" },
    { type: "assistant", message: { content: [] } },
    { type: "assistant", error: "verification_required", message: { content: [{ type: "text", text: "Verify your account" }] } },
    { type: "assistant", parent_tool_use_id: "child", message: { content: [{ type: "text", text: "Child output" }] } },
    { type: "stream_event", parent_tool_use_id: "child", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Child output" } } },
    ...[
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_delta", usage: { output_tokens: 1 } },
      { type: "message_stop" },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "" } },
      { type: "content_block_delta", delta: { type: "signature_delta", signature: "metadata" } },
      { type: "content_block_delta", delta: null },
      { type: "ping" },
    ].map((event) => ({ type: "stream_event", event })),
  ])("does not end the diagnostic wait for %j", (message) => {
    expect(hasClaudeModelContent(message)).toBe(false);
  });

  it.each([
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Checking the files" },
    { type: "redacted_thinking", data: "opaque-native-content" },
    { type: "tool_use", name: "Write", id: "write", input: {} },
    { type: "server_tool_use", name: "web_search", id: "search", input: {} },
  ])("recognizes initial and completion-only %j content", (block) => {
    expect(hasClaudeModelContent({ type: "stream_event", event: { type: "content_block_start", content_block: block } })).toBe(true);
    expect(hasClaudeModelContent({ type: "assistant", message: { content: [block] } })).toBe(true);
  });
});
