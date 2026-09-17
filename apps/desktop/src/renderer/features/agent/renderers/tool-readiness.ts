import type { AgentToolMessage } from "../use-agent-session";
import { toolCompletionUnreported } from "./raw-output";
import { toolRecord } from "./native-tool-presentation";

/** Keep provisional native records in state; expose the same durable row when
 * its command/target is ready. Terminal and missing-completion records always
 * remain inspectable, even when the producer never supplied arguments. */
export function toolPresentationReady(tool: AgentToolMessage): boolean {
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
