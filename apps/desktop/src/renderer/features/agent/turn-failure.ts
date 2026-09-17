import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import type { AgentFailure } from "../../platform/bridge/failure";

export interface TurnFailure {
  message: string;
  kind: string;
  newChatAllowed: boolean;
}

export function turnFailureForCard(input: {
  events: AgentMessage[];
  turnId: string;
  fallback?: AgentFailure | null;
  recoveryFailure?: { kind: string; message: string };
  live?: boolean;
  retrying?: boolean;
  status?: string;
  stopReason?: string | null;
}): TurnFailure | null {
  if (
    input.live ||
    input.retrying ||
    input.stopReason === "cancelled" ||
    input.status === "cancelled"
  )
    return null;
  let notice: Extract<AgentMessage, { kind: "error_notice" }> | undefined;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i];
    if (
      event.kind === "error_notice" &&
      !event.parentToolId &&
      event.code === "claude-background-recovered" &&
      (!event.turnFailure || event.turnFailure.turnId === input.turnId)
    )
      return null;
    if (
      event.kind === "error_notice" &&
      !event.parentToolId &&
      !event.recoverable &&
      event.severity === "error" &&
      (!event.turnFailure || event.turnFailure.turnId === input.turnId)
    ) {
      notice = event;
      break;
    }
  }
  const backgroundFailure =
    notice?.code === "claude-background-failed" ||
    notice?.code === "claude-background-transport-closed";
  if (input.status === "completed" && !backgroundFailure) return null;
  const fallback = input.fallback ?? input.recoveryFailure;
  const message =
    notice?.kind === "error_notice" ? notice.message : fallback?.message;
  if (!message) return null;
  const kind =
    (notice?.code === "claude-background-transport-closed"
      ? "transport-closed"
      : undefined) ??
    (notice?.kind === "error_notice" ? notice.turnFailure?.kind : undefined) ??
    notice?.failureKind ??
    fallback?.kind ??
    "protocol-error";
  // A new chat is an explicit retry destination, including for provider limits;
  // preserve the provider's reason without promising that this resolves it.
  // A new conversation cannot fix account verification or cloud credentials.
  // Authentication has its own Sign in action. The caller also gates ownership
  // and Design scope before supplying any retry callbacks.
  const newChatAllowed = ![
    "auth-required", "verification-required", "cloud-credentials-unavailable",
  ].includes(kind);
  return {
    message: redactLogSecrets(message).slice(0, 8000),
    kind,
    newChatAllowed,
  };
}
