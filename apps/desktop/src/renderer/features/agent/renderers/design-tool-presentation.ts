import { DESIGN_MCP_SERVER } from "@zeros/protocol/composer-mode";
import type { AgentToolMessage } from "../use-agent-session";
import { toolRecord } from "./native-tool-presentation";

const labels: Record<string, string> = {
  design_capabilities: "Inspect",
  design_mode_set: "Switch mode",
  design_document_list: "List",
  design_document_open: "Inspect",
  design_source_read: "Inspect",
  design_projection_read: "Inspect",
  design_foundation_read: "Inspect Styles",
  design_provenance_read: "Inspect Styles",
  design_transaction_apply: "Edit",
  design_lint: "Validate",
  design_render: "Inspect",
  design_capture: "Capture",
  design_history_undo: "Undo",
  design_history_redo: "Redo",
  design_frame_create: "Create",
  design_frame_rename: "Rename",
  design_frame_duplicate: "Duplicate",
  design_frame_delete: "Delete",
  design_request_status: "Inspect",
  design_request_list: "List",
};

/** Use native MCP identity, never an unqualified Design-looking tool name.
 * Codex reports server/tool; Claude reports the qualified native name; Cursor
 * preserves that name in toolName/providerIdentifier. Explicit foreign server
 * identity always wins over a misleading title or argument. */
export function designToolLabel(tool: AgentToolMessage): string | null {
  if (tool.toolKind !== "mcp") return null;
  const input = toolRecord(tool.rawInput);
  if (typeof input.server === "string")
    return input.server === DESIGN_MCP_SERVER && typeof input.tool === "string"
      ? (labels[input.tool] ?? null)
      : null;
  if (
    typeof input.providerIdentifier === "string" &&
    !input.providerIdentifier.startsWith("mcp__")
  )
    return input.providerIdentifier === DESIGN_MCP_SERVER &&
      typeof input.toolName === "string"
      ? (labels[input.toolName] ?? null)
      : null;
  const prefix = `mcp__${DESIGN_MCP_SERVER}__`;
  for (const name of [input.toolName, input.providerIdentifier, tool.title]) {
    if (typeof name !== "string") continue;
    const qualified = name.startsWith("MCP ") ? name.slice(4) : name;
    if (qualified.startsWith(prefix))
      return labels[qualified.slice(prefix.length)] ?? null;
  }
  return null;
}
