function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const nonempty = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

function contentBlock(value: unknown): boolean {
  const block = record(value);
  if (!block) return false;
  switch (block.type) {
    case "text": return nonempty(block.text);
    case "thinking": return nonempty(block.thinking);
    case "redacted_thinking": return nonempty(block.data);
    case "tool_use":
    case "server_tool_use": return nonempty(block.name);
    default: return false;
  }
}

/** Diagnostics only: a stream envelope is not evidence of generated content.
 * Tool names/argument fragments count even before the tool row is presentable.
 * Child traffic and synthetic error prose cannot establish parent latency. */
export function hasClaudeModelContent(value: unknown): boolean {
  const message = record(value);
  if (!message || message.parent_tool_use_id || message.error) return false;
  if (message.type === "assistant") {
    const content = record(message.message)?.content;
    return Array.isArray(content)
      ? content.some(contentBlock)
      : nonempty(content);
  }
  if (message.type !== "stream_event") return false;
  const event = record(message.event);
  if (event?.type === "content_block_start")
    return contentBlock(event.content_block);
  if (event?.type !== "content_block_delta") return false;
  const delta = record(event.delta);
  switch (delta?.type) {
    case "text_delta": return nonempty(delta.text);
    case "thinking_delta": return nonempty(delta.thinking);
    case "input_json_delta": return nonempty(delta.partial_json);
    default: return false;
  }
}
