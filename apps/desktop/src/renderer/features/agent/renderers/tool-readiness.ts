import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { toolCompletionUnreported } from "./raw-output";
import { toolRecord } from "./native-tool-presentation";
import { agentReportText } from "./subagent";
import { isWorkspaceToolName } from "./workspace-tool-presentation";

/** Claude persists task lifecycle records separately from the real Agent call.
 * Hide only records represented by an exact native child identity in this
 * window. Orphans and failures not represented by the Agent stay inspectable. */
export function withoutRedundantAgentTasks(messages: AgentMessage[]): AgentMessage[] {
  const agents = new Map<string, AgentToolMessage[]>();
  for (const message of messages) {
    if (message.kind !== "tool" || !["subagent", "task"].includes(message.toolKind ?? "") || !toolPresentationReady(message)) continue;
    const id = toolRecord(message.rawOutput).agentId ?? toolRecord(message.rawInput).resume;
    if (typeof id !== "string" || !id) continue;
    const matches = agents.get(id) ?? [];
    matches.push(message);
    agents.set(id, matches);
  }
  if (!agents.size) return messages;
  const visible = messages.filter(message => {
    if (message.kind !== "tool" || message.toolKind !== "background_task") return true;
    const input = toolRecord(message.rawInput);
    if (input.taskType && input.taskType !== "local_agent") return true;
    const matches = typeof input.taskId === "string" ? agents.get(input.taskId) : undefined;
    if (!matches) return true;
    const unreported = toolCompletionUnreported(message.rawOutput);
    if (message.status === "failed" || unreported) {
      const output = toolRecord(message.rawOutput);
      const details = [output.error, output.summary].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      // Status can precede the explanation. Hide a failed lifecycle row only
      // when the matching Agent actually displays all of its failure details,
      // including histories written before that Agent could be enriched.
      return !matches.some(agent =>
        (message.status !== "failed" || agent.status === "failed") &&
        (!unreported || toolCompletionUnreported(agent.rawOutput)) &&
        details.every(detail => agentReportText(agent).includes(detail.trim())),
      );
    }
    return false;
  });
  return visible.length === messages.length ? messages : visible;
}

/** Compatibility with Codex builds that persisted exec-server connection
 * bookkeeping as synthetic completed tools. Match that exact record shape;
 * never hide native tools, unknown payloads or genuine execution failures. */
export function isLegacyEnvironmentConnection(tool: AgentToolMessage): boolean {
  if (tool.toolKind !== "other" || tool.status !== "completed" ||
      tool.nativeToolCallId || tool.rawInput != null) return false;
  const output = toolRecord(tool.rawOutput);
  return Object.keys(output).length === 2 &&
    typeof output.environment === "string" && output.environment.length <= 160 &&
    (output.state === "connected" || output.state === "disconnected") &&
    tool.title === `Environment ${output.state}`;
}

/** Native clock.sleep is activity between tools. Match native identity and the
 * pinned display-item shape, including old generic rows, never a tool's name.
 * Unexpected results, failures and unreported completions stay inspectable. */
export function isRoutineNativeSleep(tool: AgentToolMessage): boolean {
  if (tool.toolKind !== "other" || !tool.nativeToolCallId ||
      !["pending", "in_progress", "completed"].includes(tool.status) ||
      toolCompletionUnreported(tool.rawOutput) || tool.content?.length ||
      tool.resourceLinks?.length) return false;
  const isSleepItem = (value: unknown) => {
    const item = toolRecord(value);
    return item.type === "sleep" && item.id === tool.nativeToolCallId &&
      typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0 &&
      Object.keys(item).every((key) => ["type", "id", "durationMs"].includes(key));
  };
  return isSleepItem(tool.rawInput) && (tool.rawOutput == null
    ? tool.status !== "completed"
    : isSleepItem(tool.rawOutput));
}

/** How long the loader line keeps naming a call that has finished while a
 * newer call still waits for its description. Then the line returns to its
 * timer: the newer call is never shown by its name alone (it shows once its
 * description is known), and the line must not look stuck on the old one. */
export const PROVISIONAL_WAIT_MS = 2_000;

/** Titles the adapters give a call before its input is known ("Editing
 * file", "Running shell command", a bare tool name). Never a description:
 * a call titled like this shows by its name alone. */
const PLACEHOLDER_TITLE = new RegExp("^(?:" + [
  "Reading file", "Editing files?", "Running shell command", "Searching for files", "Searching web",
  "Fetching URL", "Finding tools", "Grep", "Glob", "Subagent", "Skill", "Bash", "Shell", "Execute",
  "Read", "Edit", "Write", "MultiEdit", "List", "List files", "Fetch", "WebFetch", "WebSearch",
  "Web search", "Agent", "Task", "Spawn[ _]?agent",
].join("|") + ")$", "i");

export function placeholderTitle(title: string | undefined): boolean {
  return !title?.trim() || PLACEHOLDER_TITLE.test(title.trim());
}

/** Whether a call's description is known: the input field its row names, or
 * a provider title that is more than a placeholder. Kinds without a
 * description (named by title alone) always are. */
export function toolDescribed(tool: AgentToolMessage): boolean {
  const input = toolRecord(tool.rawInput);
  const has = (...keys: string[]) =>
    keys.some(
      (key) =>
        typeof input[key] === "string" &&
        (input[key] as string).trim().length > 0,
    );
  const titled = !placeholderTitle(tool.title);
  switch (tool.toolKind) {
    case "execute":
      return has("command", "cmd", "script") || titled;
    case "read":
      return has("path", "file_path", "filePath", "targetFile", "target_file") || titled;
    case "edit":
      return has("file_path", "path", "filePath", "target_file", "targetFile") ||
        Array.isArray(input.changes) && input.changes.length > 0 || titled;
    case "list":
      return has("path", "dir", "directory", "command") || /^List\s+(?!files$)\S/.test(tool.title);
    case "search":
      return has("pattern", "query", "glob", "globPattern", "searchTerm", "command", "regex") || /^(Grep|Glob)\s+\S/.test(tool.title);
    case "fetch":
      return has("url", "URL") || titled;
    case "web_search":
      return has("query", "q") || Object.keys(toolRecord(input.action)).length > 0 || titled;
    case "skill":
      return has("skill", "command", "name") || titled;
    case "subagent":
    case "task":
      return has("description", "prompt", "task", "agentPath", "name") || titled;
    default:
      return true;
  }
}

/** Keep provisional records in state; expose the same durable row once its
 * description is known: a call is shown with its real description or not at
 * all, however long its input takes (like a thought, which shows once its
 * opening line has settled). Kinds named by their title alone show at once.
 * Terminal and missing-completion records always remain inspectable, even
 * when the producer never supplied arguments. */
export function toolPresentationReady(tool: AgentToolMessage): boolean {
  if (isLegacyEnvironmentConnection(tool) || isRoutineNativeSleep(tool) || isWorkspaceToolLoading(tool)) return false;
  if (
    !["pending", "in_progress"].includes(tool.status) ||
    toolCompletionUnreported(tool.rawOutput)
  )
    return true;
  return toolDescribed(tool);
}

/** When the oldest live call still waiting for its description started, or
 * null when none waits. */
export function provisionalCallSince(messages: readonly AgentMessage[]): number | null {
  let since: number | null = null;
  for (const message of messages) {
    if (message.kind !== "tool" || toolPresentationReady(message)) continue;
    if (isLegacyEnvironmentConnection(message) || isRoutineNativeSleep(message) || isWorkspaceToolLoading(message)) continue;
    if (since === null || message.createdAt < since) since = message.createdAt;
  }
  return since;
}

/** A tool search is harness mechanics. It never shows while pending (its query
 * may still be streaming, so it could flash "Finding tools" before the tool's own
 * row), and a finished one shows only when it loaded something other than
 * zeros_workspace tools, by its select list or by the tools its output names. */
export function isWorkspaceToolLoading(tool: AgentToolMessage): boolean {
  if (tool.toolKind !== "tool_search") return false;
  if (tool.status === "pending" || tool.status === "in_progress") return true;
  const query = toolRecord(tool.rawInput).query;
  const selected = typeof query === "string" && query.startsWith("select:")
    ? query.slice("select:".length).split(",").map(name => name.trim()).filter(Boolean) : [];
  const loaded = selected.length ? selected : loadedToolNames(tool);
  return loaded.length > 0 && loaded.every(isWorkspaceToolName);
}

/** Tool names a finished search's result references (tool_reference blocks), bounded. */
function loadedToolNames(tool: AgentToolMessage): string[] {
  const names: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || names.length >= 64) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 64)) visit(item, depth + 1); return; }
    const record = toolRecord(value);
    if (record.type === "tool_reference" && typeof record.tool_name === "string") { names.push(record.tool_name); return; }
    for (const key of ["content", "rawOutput"]) if (key in record) visit(record[key], depth + 1);
  };
  visit(tool.rawOutput, 0);
  visit(tool.content, 0);
  return names;
}
