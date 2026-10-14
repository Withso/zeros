import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { toolCompletionUnreported } from "./raw-output";
import { toolRecord } from "./native-tool-presentation";
import { agentReportText } from "./subagent";

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

/** Keep provisional native records in state; expose the same durable row when
 * its command/target is ready. Terminal and missing-completion records always
 * remain inspectable, even when the producer never supplied arguments. */
export function toolPresentationReady(tool: AgentToolMessage): boolean {
  if (isLegacyEnvironmentConnection(tool) || isRoutineNativeSleep(tool)) return false;
  if (
    !["pending", "in_progress"].includes(tool.status) ||
    toolCompletionUnreported(tool.rawOutput)
  )
    return true;
  const input = toolRecord(tool.rawInput);
  const has = (...keys: string[]) =>
    keys.some(
      (key) =>
        typeof input[key] === "string" &&
        (input[key] as string).trim().length > 0,
    );
  switch (tool.toolKind) {
    case "execute":
      return (
        has("command", "cmd", "script") ||
        !/^(Bash|Shell|Running shell command|Execute)$/i.test(tool.title)
      );
    case "read":
      return (
        has("path", "file_path", "filePath", "targetFile") ||
        /^Read\s+\S/.test(tool.title)
      );
    case "list":
      return (
        has("path", "dir", "directory", "command") ||
        /^List\s+(?!files$)\S/.test(tool.title)
      );
    case "search":
      return (
        has(
          "pattern",
          "query",
          "glob",
          "globPattern",
          "searchTerm",
          "command",
        ) || /^(Grep|Glob)\s+\S/.test(tool.title)
      );
    case "subagent":
    case "task":
      return (
        has("description", "prompt", "task", "agentPath", "name") ||
        !/^(Agent|Task|Subagent|Spawn[ _]?agent)$/i.test(tool.title)
      );
    default:
      return true;
  }
}
