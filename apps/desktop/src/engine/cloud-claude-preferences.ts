import type { CloudQueuedPrompt } from "@zeros/protocol/cloud-commands";

/** Commands retain the sending actor's settings through cold admission and
 * background reuse. Legacy payloads keep native memory On and compaction Off. */
export function cloudClaudePreferencesEnv(
  payload: Pick<CloudQueuedPrompt, "agentId" | "claudePreferences">,
): Record<string, string> {
  if (payload.agentId !== "claude") return {};
  return {
    ZEROS_CLAUDE_AUTO_MEMORY: payload.claudePreferences?.autoMemoryEnabled === false ? "0" : "1",
    ZEROS_CLAUDE_IDLE_COMPACTION: payload.claudePreferences?.idleCompactionEnabled === true ? "1" : "0",
  };
}
