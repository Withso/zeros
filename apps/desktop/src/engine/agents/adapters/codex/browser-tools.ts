import {
  BROWSER_TOOL_NAMESPACE,
  isBrowserToolName,
} from "@zeros/protocol/browser-tools";

import type { AgentBrowserTools } from "../../types";
import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec";

export function codexBrowserDynamicTools(
  binding: AgentBrowserTools | undefined,
): DynamicToolSpec[] | undefined {
  if (!binding) return undefined;
  return [
    {
      type: "namespace",
      name: BROWSER_TOOL_NAMESPACE,
      description:
        "Control the isolated browser owned by this Zeros conversation. Use it for website navigation, inspection, interaction, screenshots, and traces.",
      tools: binding.definitions.map((definition) => ({
        type: "function",
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema as never,
        deferLoading: false,
      })),
    },
  ];
}

export function createCodexBrowserToolHandler(
  binding: AgentBrowserTools | undefined,
):
  | ((params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>)
  | undefined {
  if (!binding) return undefined;
  return async (params) => {
    if (
      params.namespace !== BROWSER_TOOL_NAMESPACE ||
      !isBrowserToolName(params.tool)
    ) {
      return failure(
        "The browser tool call does not belong to this Zeros conversation.",
      );
    }
    const result = await binding.execute(
      params.tool,
      params.arguments as never,
    );
    return {
      success: result.success,
      contentItems: result.content.map((item) =>
        item.type === "text"
          ? { type: "inputText" as const, text: item.text }
          : {
              type: "inputImage" as const,
              imageUrl: `data:${item.mimeType};base64,${item.data}`,
            },
      ),
    };
  };
}

function failure(text: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text }],
  };
}
