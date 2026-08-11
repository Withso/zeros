import type {
  BrowserJsonValue,
  BrowserToolContent,
  BrowserToolName,
  BrowserToolResult,
} from "@zeros/protocol/browser-tools";

import type { AgentBrowserTools } from "../agents/types";

export interface CursorBrowserCustomTool {
  description: string;
  inputSchema: Record<string, BrowserJsonValue>;
  execute(args: Record<string, BrowserJsonValue>): Promise<{
    content: BrowserToolContent[];
    isError: boolean;
  }>;
}

/** Translate the canonical manifest into Cursor's in-process custom-tool API.
 * The prefix is transport namespacing only; schemas and execution remain the
 * same provider-neutral Zeros contract. */
export function cursorBrowserCustomTools(
  binding: AgentBrowserTools | undefined,
): Record<string, CursorBrowserCustomTool> | undefined {
  if (!binding) return undefined;
  return Object.fromEntries(
    binding.definitions.map((definition) => [
      `zeros_browser_${definition.name}`,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (args: Record<string, BrowserJsonValue>) => {
          const result = await binding.execute(
            definition.name,
            args as BrowserJsonValue,
          );
          return { content: result.content, isError: !result.success };
        },
      },
    ]),
  );
}

export function browserResultAsText(result: BrowserToolResult): string {
  return result.content
    .filter(
      (item): item is Extract<BrowserToolContent, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

export function browserToolFromProviderName(
  value: string,
): BrowserToolName | null {
  const name = value.startsWith("zeros_browser_")
    ? value.slice("zeros_browser_".length)
    : value;
  return name === "open" ||
    name === "snapshot" ||
    name === "click" ||
    name === "type" ||
    name === "upload" ||
    name === "resize" ||
    name === "back" ||
    name === "forward" ||
    name === "reload" ||
    name === "screenshot" ||
    name === "trace" ||
    name === "close"
    ? name
    : null;
}
