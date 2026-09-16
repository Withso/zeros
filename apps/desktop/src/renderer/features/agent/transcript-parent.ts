import type { AgentMessage } from "./use-agent-session";

/** Canonical parent association used to nest the visible transcript. */
export function transcriptParentId(message: AgentMessage): string | undefined {
  return "parentToolId" in message ? message.parentToolId : undefined;
}
