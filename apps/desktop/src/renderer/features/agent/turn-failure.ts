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
    fallback?.kind ??
    "protocol-error";
  // A fresh conversation can repair lost/corrupt session state. Provider-wide
  // limits, model availability and policy rejections need the same remedy in
  // either chat, so avoid suggesting that a new chat would fix them.
  const sessionRecovery = [
      "session-expired",
      "transport-closed",
      "timeout",
      "subprocess-exited",
    ].includes(kind) || (kind === "protocol-error" && /context\s+(?:window|length).{0,40}(?:exceeded|limit)|(?:session|conversation|thread).{0,40}(?:corrupt|invalid|expired|not found)/i.test(message));
  const newChatAllowed = sessionRecovery &&
    !/capacity|rate.?limit|quota|billing|flagged|cybersecurity|policy|model.{0,60}(?:unavailable|not found|not supported|rejected)/i.test(
      message,
    );
  return {
    message: redactLogSecrets(message).slice(0, 8000),
    kind,
    newChatAllowed,
  };
}
