import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { toolRecord } from "./native-tool-presentation";
import { commandResultOutput, toolCompletionUnreported } from "./raw-output";
import { literalCommandWords } from "./tool-command";

/** gh documents exit 8 as pending checks. This is presentation only: the
 * command really exited nonzero, and its native status/result remain intact.
 * https://cli.github.com/manual/gh_pr_checks */
export function pendingChecksMessage(tool: AgentToolMessage): string | null {
  if (tool.toolKind !== "execute" ||
      !["completed", "failed"].includes(tool.status) ||
      toolCompletionUnreported(tool.rawOutput)) return null;
  const words = literalCommandWords(tool.rawInput);
  if (!words || !/^(?:\/.*\/)?gh$/.test(words[0] ?? "") ||
      words[1] !== "pr" || words[2] !== "checks") return null;

  const outer = toolRecord(tool.rawOutput);
  const output = toolRecord(commandResultOutput(tool.rawOutput));
  if (outer.error != null || output.error != null ||
      [outer.status, output.status].some((status) =>
        ["cancelled", "declined", "interrupted", "error"].includes(String(status)))) return null;
  if (output.exitCode === 8) return "Checks are still running.";

  // JSON mode can exit zero while buckets are still pending. Only the native
  // unfiltered bucket array is evidence; arbitrary text or jq/template output
  // cannot establish the check state. A failed/cancelled bucket is not pending.
  if (tool.status !== "completed" || output.exitCode !== 0 || words.some((word) =>
    /^(?:--jq(?:=|$)|--template(?:=|$)|-[qt])/.test(word))) return null;
  const jsonIndex = words.indexOf("--json", 3);
  const fields = jsonIndex >= 0 ? words[jsonIndex + 1] : words.slice(3).find((word) => word.startsWith("--json="))?.slice(7);
  if (!fields?.split(",").includes("bucket")) return null;
  const text = output.output ?? output.stdout;
  if (typeof text !== "string" || text.length > 256_000) return null;
  try {
    const checks: unknown = JSON.parse(text);
    if (Array.isArray(checks) && checks.length > 0 &&
        checks.every((check) => ["pass", "pending", "skipping"].includes(String(toolRecord(check).bucket))) &&
        checks.some((check) => toolRecord(check).bucket === "pending"))
      return "Checks are still running.";
  } catch {
    // Incomplete or non-JSON output keeps the ordinary command presentation.
  }
  return null;
}
