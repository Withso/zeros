import { canonicalToolContent, mergeToolContent } from "../shared/tool-content";
import type { ContentBlock } from "../../types";

type RecordValue = Record<string, unknown>;
export type CursorToolStatus = "pending" | "completed" | "failed";
export type CursorToolContent = Array<{
  type: "content";
  content: ContentBlock;
}>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

/** SDK results and the older protobuf/CLI serializations of the same result. */
export function cursorToolResultValue(result: unknown): RecordValue {
  const outer = record(result);
  const oneof = record(outer.result);
  return record(outer.value ?? outer.success ?? oneof.value);
}

function shellTool(name: string): boolean {
  return /^(shell|bash|exec(?:_command)?|execute|terminal|run)(ToolCall)?$/i.test(
    name,
  );
}

/** A successful SDK wrapper means the tool was dispatched. Shell exit status
 * and MCP isError still decide whether the operation itself succeeded. Never
 * infer failure from arbitrary output prose or the presence of stderr. */
export function cursorToolStatus(
  name: string,
  result: unknown,
  completionReported = false,
): CursorToolStatus {
  const outer = record(result);
  const oneof = record(outer.result);
  const value = cursorToolResultValue(result);
  const hasError = (v: unknown) => v != null && v !== false && v !== "";
  if (
    outer.status === "error" ||
    outer.status === "failed" ||
    oneof.case === "error" ||
    hasError(outer.error) ||
    outer.is_error === true ||
    outer.isError === true ||
    value.isError === true ||
    (/^mcp/i.test(name) && record(value.raw).isError === true)
  )
    return "failed";

  if (shellTool(name)) {
    const payload = "exitCode" in outer || "signal" in outer ? outer : value;
    if (typeof payload.signal === "string" && payload.signal.trim())
      return "failed";
    // A malformed/missing exit code is not positive evidence of success.
    if (
      typeof payload.exitCode !== "number" ||
      !Number.isInteger(payload.exitCode)
    )
      return "pending";
    return payload.exitCode === 0 ? "completed" : "failed";
  }
  if (
    outer.status === "success" ||
    oneof.case === "success" ||
    outer.success != null ||
    completionReported
  )
    return "completed";
  return "pending";
}

/** Text from the documented result fields, including Anthropic-style child
 * tool_result blocks and Cursor's MCP { text: { text } } blocks. Binary fields
 * are left to the existing media presenter, never JSON-encoded as prose. */
export function cursorToolResultContent(
  result: unknown,
): CursorToolContent | undefined {
  const outer = record(result);
  const oneof = record(outer.result);
  const value = cursorToolResultValue(result);
  const texts: string[] = [];
  const rich: CursorToolContent = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length && !texts.includes(v)) texts.push(v);
  };
  const addContent = (content: unknown) => {
    // SDK McpToolResultContentItem has separate optional text/image wrappers.
    // Transcript fallback uses ordinary MCP blocks, so accept both contracts.
    const blocks = Array.isArray(content) ? content.slice(0, 128).flatMap(candidate => {
      const image = record(record(candidate).image);
      return typeof image.data === "string" ? [candidate, { type: "image", ...image }] : [candidate];
    }) : content;
    for (const block of canonicalToolContent(blocks)) {
      if (block.content.type === "text") add(block.content.text);
      else rich.push(block);
    }
  };
  const error =
    outer.error ?? (oneof.case === "error" ? oneof.value : undefined);
  add(error);
  add(record(error).message);
  for (const payload of [outer, value, record(value.raw)]) {
    add(payload.stdout);
    add(payload.stderr);
    addContent(payload.content);
    addContent(payload.resourceLinks);
  }
  if (typeof result === "string" || Array.isArray(result)) addContent(result);
  const content = mergeToolContent(canonicalToolContent(texts.join("\n")), rich);
  return content.length ? content : undefined;
}

/** Private presentation metadata inside the existing rawOutput field. A
 * stopped child with no captured result is neither successful nor running. */
export function unreportedToolOutput(rawOutput: unknown): RecordValue {
  return {
    ...(rawOutput !== null &&
    typeof rawOutput === "object" &&
    !Array.isArray(rawOutput)
      ? (rawOutput as RecordValue)
      : rawOutput === undefined
        ? {}
        : { output: rawOutput }),
    _zerosToolCompletion: "unreported",
  };
}
