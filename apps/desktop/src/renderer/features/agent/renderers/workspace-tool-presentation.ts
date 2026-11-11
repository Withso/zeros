import { BellRing, FileDiff, Laptop, SquareTerminal, Terminal, Wrench } from "lucide-react";
import type { AgentToolMessage } from "../use-agent-session";
import { toolRecord } from "./native-tool-presentation";
import type { EventMeta } from "./event-meta";

const SERVER = "zeros_workspace";

/** A command on the person's Mac: a laptop, then a terminal prompt, as two
 * glyphs side by side (as Conductor shows it) wherever a local command appears. */
export const LOCAL_COMMAND_ICONS = [Laptop, Terminal] as const;

/** A zeros_workspace tool by native MCP identity: Codex server/tool, Claude's
 * qualified name, Cursor's providerIdentifier/toolName. Never an unqualified
 * name or a foreign server's misleading title. */
export function workspaceToolCall(tool: AgentToolMessage): { name: string; args: Record<string, unknown> } | null {
  if (tool.toolKind !== "mcp") return null;
  const input = toolRecord(tool.rawInput);
  if (typeof input.server === "string")
    return input.server === SERVER && typeof input.tool === "string" ? { name: input.tool, args: toolRecord(input.arguments) } : null;
  if (typeof input.providerIdentifier === "string" && !input.providerIdentifier.startsWith("mcp__"))
    return input.providerIdentifier === SERVER && typeof input.toolName === "string" ? { name: input.toolName, args: toolRecord(input.args) } : null;
  const prefix = `mcp__${SERVER}__`;
  for (const value of [input.toolName, input.providerIdentifier, tool.title]) {
    if (typeof value !== "string") continue;
    const name = value.replace(/^MCP /, "");
    if (name.startsWith(prefix) && name.length > prefix.length) return { name: name.slice(prefix.length), args: input };
  }
  return null;
}

/** Any provider's spelling of a zeros_workspace tool name (for tool search rows). */
export const isWorkspaceToolName = (name: string) => /^(?:mcp__zeros_workspace__|zeros_workspace[:.])[A-Za-z][A-Za-z0-9_]*$/.test(name.trim());

const OUTCOME_WORDS: Record<string, string> = {
  denied: "Denied", approval_timed_out: "Approval timed out", command_timed_out: "Timed out", mac_not_connected: "Mac not connected",
  no_target: "No Mac to run on", disabled: "Local commands are off", cancelled: "Stopped", interrupted: "Interrupted",
};

function resultText(tool: AgentToolMessage): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") { parts.push(value); return; }
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const outer = toolRecord(item), block = outer.type === "content" ? toolRecord(outer.content) : outer;
      if (typeof item === "string") parts.push(item);
      else if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  };
  visit(tool.content);
  if (!parts.length) { const raw = toolRecord(tool.rawOutput); visit(raw.content); if (typeof tool.rawOutput === "string") parts.push(tool.rawOutput); }
  return parts.join("\n").slice(0, 4096);
}
const line = (text: string, key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(text)?.[1]?.trim();

/** Where a RunLocalCommand row stands, beyond its own record: the Mac whose
 * pending approval main holds for this call's chat, if any. */
export interface LocalCommandRowState { waitingOn?: string }

/** RunLocalCommand: what it does (its description) and the command, known as soon
 * as its arguments are, also while running. The generic title is only a fallback
 * while they are not, and never claims an approval. A pending call says it waits
 * for approval only while main really holds one; a success adds no words; every
 * other ending is plain words on a neutral row. */
function localCommandMeta(tool: AgentToolMessage, args: Record<string, unknown>, state: LocalCommandRowState = {}): EventMeta {
  const description = typeof args.description === "string" && args.description.trim() ? args.description.replace(/\s+/g, " ").trim().slice(0, 120) : "Run a command on your Mac";
  const command = localCommandText(args);
  const [Icon, SecondIcon] = LOCAL_COMMAND_ICONS;
  const base = { Icon, SecondIcon, label: description, ...(command ? { target: command } : {}), expandable: true };
  if (tool.status === "pending" || tool.status === "in_progress")
    return state.waitingOn ? { ...base, trailing: `Waiting for approval on ${state.waitingOn.slice(0, 128)}` } : base;
  const text = resultText(tool), outcome = line(text, "outcome"), exit = line(text, "exit code"), error = line(text, "error");
  let words: string | undefined;
  if (outcome === "completed") words = exit && exit !== "0" ? `Failed with exit code ${exit}` : undefined;
  else if (outcome === "failed") words = error === "cwd_not_found" ? "Folder not found" : "Could not start";
  else if (outcome && OUTCOME_WORDS[outcome]) words = OUTCOME_WORDS[outcome]!;
  else words = tool.status === "failed" ? "Outcome unknown" : undefined;
  // Every ending reads as words on a neutral row, never a generic red "Error".
  return { ...base, ...(words ? { trailing: words } : {}), tone: "ok" };
}
const localCommandText = (args: Record<string, unknown>) =>
  typeof args.command === "string" && args.command.trim() ? args.command.replace(/\s+/g, " ").trim().slice(0, 160) : undefined;

/** A RunLocalCommand call's command as the approval shows it, for matching main's pending approvals. */
export function localCommandCall(tool: AgentToolMessage): { command: string | undefined } | null {
  const call = workspaceToolCall(tool);
  return call?.name === "RunLocalCommand" ? { command: typeof call.args.command === "string" ? call.args.command : undefined } : null;
}

const humanize = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, first => first.toUpperCase());

/** A human row for every zeros_workspace tool: never the raw `mcp__…` name. */
export function workspaceToolMeta(tool: AgentToolMessage, state?: LocalCommandRowState): EventMeta | null {
  const call = workspaceToolCall(tool);
  if (!call) return null;
  const { name, args } = call;
  if (name === "RunLocalCommand") return localCommandMeta(tool, args, state);
  if (name === "NotifyUser") {
    const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    return tool.status === "failed" ? { Icon: BellRing, label: "Notification not sent", ...(title ? { target: title } : {}), tone: "ok", expandable: true }
      : { Icon: BellRing, label: title ? `Notified you: ${title}` : "Notified you", expandable: true };
  }
  if (name === "GetTerminalOutput") {
    const which = typeof args.terminalId === "string" ? args.terminalId : typeof args.source === "string" && args.source !== "auto" ? args.source.replace(/_/g, " ") : undefined;
    return { Icon: SquareTerminal, label: "Read terminal output", ...(which ? { target: which } : {}), expandable: true };
  }
  if (name === "GetWorkspaceDiff") {
    const file = typeof args.file === "string" ? args.file : undefined;
    return { Icon: FileDiff, label: args.stat === true ? "Read changed files" : "Read workspace diff", ...(file ? { target: file } : {}), expandable: true };
  }
  return { Icon: Wrench, label: humanize(name).slice(0, 80), expandable: true };
}

/** RunLocalCommand's reason (wire v1.3), shown as a muted line above its row; one line, bounded. */
export function localCommandReason(tool: AgentToolMessage): string | undefined {
  const call = workspaceToolCall(tool);
  if (call?.name !== "RunLocalCommand" || typeof call.args.reason !== "string") return undefined;
  const reason = call.args.reason.replace(/\s+/g, " ").trim().slice(0, 280);
  return reason || undefined;
}
