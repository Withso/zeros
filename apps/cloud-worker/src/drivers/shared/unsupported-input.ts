import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@zeros/protocol/agent-events";

export function unsupportedInputNotice(sessionId: string, kind: "question" | "elicitation"): SessionNotification {
  const message = kind === "question"
    ? "The agent asked a question. The request was cancelled because cloud workspaces cannot answer it yet. Continue in a Local workspace."
    : "An MCP tool asked for input. The request was cancelled because cloud workspaces cannot answer it yet. Run this tool in a Local workspace.";
  return { sessionId, update: { sessionUpdate: "error_notice", noticeId: `cloud-input:${randomUUID()}`,
    code: kind === "question" ? "cloud-question-unsupported" : "cloud-mcp-elicitation-unsupported",
    severity: "warning", recoverable: true, message } };
}
