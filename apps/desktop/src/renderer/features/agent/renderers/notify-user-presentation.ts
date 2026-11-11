import type { AgentToolMessage } from "../use-agent-session";
import { toolRecord } from "./native-tool-presentation";

const SERVER = "zeros_workspace", TOOL = "NotifyUser";

/** zeros_workspace's NotifyUser by native MCP identity (Codex server/tool,
 * Claude's qualified name, Cursor's providerIdentifier/toolName); never an
 * unqualified name or a foreign server's title. */
function notifyUserCall(tool: AgentToolMessage): Record<string, unknown> | null {
  if (tool.toolKind !== "mcp") return null;
  const input = toolRecord(tool.rawInput);
  if (typeof input.server === "string")
    return input.server === SERVER && input.tool === TOOL ? toolRecord(input.arguments) : null;
  if (typeof input.providerIdentifier === "string" && !input.providerIdentifier.startsWith("mcp__"))
    return input.providerIdentifier === SERVER && input.toolName === TOOL ? toolRecord(input.args) : null;
  const qualified = `mcp__${SERVER}__${TOOL}`;
  return [input.toolName, input.providerIdentifier, tool.title].some(name => typeof name === "string" && name.replace(/^MCP /, "") === qualified)
    ? input : null;
}

const titleOf = (args: Record<string, unknown>) => typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";

/** "Notified you: <title>", or that it was not sent. */
export function notifyUserLabel(tool: AgentToolMessage): string | null {
  const args = notifyUserCall(tool);
  if (!args) return null;
  if (tool.status === "failed") return "Notification not sent";
  const title = titleOf(args);
  return title ? `Notified you: ${title}` : "Notified you";
}

/** A failed row keeps the shared "Error" label (event-row); its target names what was not sent. */
export function notifyUserFailedTarget(tool: AgentToolMessage): string | undefined {
  const args = notifyUserCall(tool);
  return args && tool.status === "failed" ? titleOf(args) || undefined : undefined;
}
