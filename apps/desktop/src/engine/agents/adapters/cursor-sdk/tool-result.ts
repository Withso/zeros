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
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length && !texts.includes(v)) texts.push(v);
  };
  const addContent = (content: unknown) => {
    if (typeof content === "string") add(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = record(block);
        if (b.type === "text") add(b.text);
        else if (typeof b.text === "object") add(record(b.text).text);
      }
    }
  };
  const error =
    outer.error ?? (oneof.case === "error" ? oneof.value : undefined);
  add(error);
  add(record(error).message);
  for (const payload of [outer, value]) {
    add(payload.stdout);
    add(payload.stderr);
    addContent(payload.content);
  }
  if (typeof result === "string" || Array.isArray(result)) addContent(result);
  return texts.length
    ? [{ type: "content", content: { type: "text", text: texts.join("\n") } }]
    : undefined;
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
