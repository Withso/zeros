import type { AgentToolMessage } from "../use-agent-session";
import { fileRefPath } from "../markdown-file-path";
import { toolRecord } from "./native-tool-presentation";

/** Native operation identity, never words in a result or the user's prompt. */
export function isImageGenerationTool(tool: AgentToolMessage): boolean {
  const input = toolRecord(tool.rawInput);
  return [input.tool, tool.title].some(
    (value) =>
      typeof value === "string" &&
      /^(?:(?:mcp__)?[\w-]+__)?(?:generate_?image|image_?generation|imagegen|generat(?:e|ing) image)$/i.test(
        value,
      ),
  );
}

export function generatedImagePath(tool: AgentToolMessage): string | undefined {
  if (!isImageGenerationTool(tool)) return undefined;
  const output = toolRecord(tool.rawOutput);
  const value = toolRecord(output.value);
  const linkedImage = [
    ...(tool.resourceLinks ?? []),
    ...(tool.content ?? []).flatMap((block) =>
      block.type === "content" && block.content.type === "resource_link"
        ? [block.content]
        : [],
    ),
  ].find(
    (link) =>
      link.mimeType?.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(link.uri),
  );
  // A requested destination is not evidence that generation produced a file.
  // Only native result paths and explicit resource links own saved artifacts.
  return [
    output.savedPath,
    value.filePath,
    output.filePath,
    linkedImage?.uri,
  ]
    .map((value) =>
      typeof value === "string" ? fileRefPath(value, true) : null,
    )
    .find((value): value is string => !!value);
}

/** Structured MCP output complements its readable content. Exclude routine
 * wrapper/transport metadata and media bytes; the renderer bounds the preview. */
export function structuredToolOutput(raw: unknown): unknown {
  const outer = toolRecord(raw);
  const oneof = toolRecord(outer.result);
  const value = toolRecord(outer.value ?? outer.success ?? oneof.value ?? raw);
  const payload = Object.keys(toolRecord(value.raw)).length
    ? toolRecord(value.raw)
    : value;
  if (payload.structuredContent !== undefined) return payload.structuredContent;
  const ignored = new Set([
    "type",
    "status",
    "content",
    "resourceLinks",
    "isError",
    "is_error",
    "exitCode",
    "durationMs",
    "duration_ms",
    "stdout",
    "stderr",
    "output",
    "text",
    "data",
    "blob",
    "imageData",
    "fileName",
    "filePath",
    "savedPath",
    "zerosTransport",
    "_meta",
  ]);
  const remaining = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => !ignored.has(key) && !key.startsWith("_zeros"),
    ),
  );
  return Object.keys(remaining).length ? remaining : undefined;
}
