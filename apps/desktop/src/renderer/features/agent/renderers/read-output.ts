import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { toolRecord } from "./native-tool-presentation";

/** File text only: never count JSON envelopes, binary payloads or error advice
 * as source. Native results also cover stored turns without canonical content. */
export function readToolText(tool: AgentToolMessage): string | null {
  if (tool.status === "failed" || failedResult(tool.rawOutput)) return null;
  return sourceText(tool.rawOutput) ?? textBlocks(tool.content);
}

export function readLineCount(tool: AgentToolMessage): number | null {
  const text = readToolText(tool);
  if (text === null) return null;
  if (text.length === 0) return 0;
  // One terminator ends the last line; it does not create another source row.
  return text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0);
}

export function readLabel(count: number | null, combined = false): string {
  return count === null
    ? "Read"
    : `Read ${count} ${count === 1 ? "line" : "lines"}${combined ? " total" : ""}`;
}

function textBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    const outer = toolRecord(item);
    const block = outer.type === "content" ? toolRecord(outer.content) : outer;
    if (typeof item === "string") parts.push(item);
    else if (block.type === "text" && typeof block.text === "string")
      parts.push(block.text);
  }
  if (!parts.length) return null;
  // Content blocks can already end at a line boundary. Don't insert phantom
  // blank lines or deduplicate genuinely repeated file text.
  return parts.reduce(
    (text, part) =>
      !text || !part || /[\r\n]$/.test(text) || /^[\r\n]/.test(part)
        ? text + part
        : `${text}\n${part}`,
    "",
  );
}

function sourceText(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return textBlocks(value);
  if (depth > 4) return null;
  const result = toolRecord(value);
  const file = toolRecord(result.file);
  if (result.type === "text" && typeof file.content === "string")
    return file.content;
  if (typeof result.content === "string") return result.content;
  const blocks = textBlocks(result.content);
  if (blocks !== null) return blocks;
  if (typeof result.output === "string") return result.output;
  if (typeof result.stdout === "string") return result.stdout;
  const oneof = toolRecord(result.result);
  for (const wrapped of [result.value, result.success, oneof.value]) {
    if (wrapped == null) continue;
    const text = sourceText(wrapped, depth + 1);
    if (text !== null) return text;
  }
  return null;
}

function failedResult(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  const result = toolRecord(value);
  const oneof = toolRecord(result.result);
  if (
    result.status === "error" ||
    result.status === "failed" ||
    result.isError === true ||
    result.is_error === true ||
    oneof.case === "error" ||
    (typeof result.exitCode === "number" && result.exitCode !== 0)
  )
    return true;
  return [result.value, result.success, oneof.value].some(
    (wrapped) => wrapped != null && failedResult(wrapped, depth + 1),
  );
}
