import type { AgentMessage, AgentTextMessage } from "@zeros/protocol/agent-messages";
import { CloudFailureSchema, cloudFailureMessage, type CloudFailure } from "@zeros/protocol/cloud-v2-relay";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { claudeOrganizationStartupCode, claudeOrganizationStartupMessage } from "@zeros/protocol/claude-startup-notice";
import type { AgentFailure } from "../../platform/bridge/failure";
import { isProviderWorkEvent } from "./transcript-notices";

export interface TurnFailure {
  cloud?: CloudFailure;
  message: string;
  kind: string;
  newChatAllowed: boolean;
  /** Team sharing: the person has no login of their own for this agent; their own sign-in fixes it, and the unsent message can be retried. */
  ownAccount?: true;
}

/** Root terminal notices are owned by the turn footer. Native notices from
 * older providers may lack a turn id; an explicit id must match exactly. */
export function isTurnFailureNotice(
  event: AgentMessage,
  turnId: string,
): event is Extract<AgentMessage, { kind: "error_notice" }> {
  return (
    event.kind === "error_notice" &&
    !event.parentToolId &&
    !event.recoverable &&
    event.severity === "error" &&
    (!event.turnFailure || event.turnFailure.turnId === turnId)
  );
}

/** A failed retry remains in durable history. Later parent work or an explicit
 * recovery receipt supersedes it only within this same provider turn. */
export function turnFailureRecovered(events: readonly AgentMessage[], turnId: string): boolean {
  let progressed = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "error_notice" && !event.parentToolId && event.code === "claude-background-recovered" &&
        (!event.turnFailure || event.turnFailure.turnId === turnId)) return true;
    if (isTurnFailureNotice(event, turnId)) return progressed;
    if (isProviderWorkEvent(event)) progressed = true;
  }
  return false;
}

export function turnFailureForCard(input: {
  events: AgentMessage[];
  turnId: string;
  fallback?: AgentFailure | null;
  recoveryFailure?: AgentTextMessage["recoveryFailure"];
  live?: boolean;
  retrying?: boolean;
  status?: string;
  stopReason?: string | null;
}): TurnFailure | null {
  if (
    input.live ||
    input.retrying ||
    turnFailureRecovered(input.events, input.turnId) ||
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
    if (isTurnFailureNotice(event, input.turnId)) {
      notice = event;
      break;
    }
  }
  const backgroundFailure =
    notice?.code === "claude-background-failed" ||
    notice?.code === "claude-background-transport-closed";
  if (input.status === "completed" && !backgroundFailure) return null;
  const fallback = input.fallback ?? input.recoveryFailure;
  const ownAccount = !notice && !input.fallback && input.recoveryFailure?.ownAccount === true;
  // A refused message's own failure keeps its cloud evidence (Creator pays: whose login is missing).
  const parsedCloud = CloudFailureSchema.safeParse(notice?.cloud ?? input.fallback?.cloud ?? (!notice && !input.fallback ? input.recoveryFailure?.cloud : undefined));
  const cloud = parsedCloud.success ? parsedCloud.data : undefined;
  const organizationMessage = claudeOrganizationStartupMessage(notice?.code) ??
    claudeOrganizationStartupMessage(claudeOrganizationStartupCode(input.fallback?.advice));
  const message =
    organizationMessage ?? (notice?.kind === "error_notice" ? notice.message : fallback?.message);
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
  const newChatAllowed = !organizationMessage && ![
    "auth-required", "verification-required", "cloud-credentials-unavailable",
  ].includes(kind);
  return {
    ...(cloud ? { cloud } : {}),
    message: cloud && !ownAccount && !(!notice && !input.fallback && input.recoveryFailure) ? cloudFailureMessage(cloud) : redactLogSecrets(message).slice(0, 8000),
    kind,
    newChatAllowed,
    ...(ownAccount ? { ownAccount: true as const } : {}),
  };
}

const AGENT_NAMES = { claude: "Claude", codex: "Codex", cursor: "Cursor" } as const;
/** What the failure card shows and offers. Creator pays: the Creator's missing login names the Creator (from the workspace
 * document and roster) and offers no connect action, only Retry; no Creator offers Retry only. */
export function turnFailureDisplay(failure: TurnFailure, creatorName: string | null, canReassign = false): {
  message: string; retry: boolean; reconnect: boolean; reconnectLabel: string | undefined; reassign: boolean } {
  const cloud = failure.cloud?.source === "provider" ? failure.cloud : undefined, reason = cloud?.reason;
  if (failure.kind === "creator-required" || reason === "creator-required")
    // 3B: someone who may reassign this workspace gets the action; everyone else is told an admin can.
    return { message: "This workspace has no Creator. An admin can reassign it.", retry: true, reconnect: false, reconnectLabel: undefined, reassign: canReassign };
  if (cloud?.loginRequiredFrom === "creator")
    return { message: `${creatorName ?? "The workspace's Creator"} needs to connect ${AGENT_NAMES[cloud.provider]} before messages can run here.`, retry: true, reconnect: false, reconnectLabel: undefined, reassign: false };
  const accountAction = reason === "auth-required" || reason === "verification-required" || reason === "credentials-unavailable";
  // An own-account refusal was never sent: after signing in, the same message can simply be retried.
  const retry = (!accountAction || failure.ownAccount === true) && reason !== "session-expired" && reason !== "model-unavailable";
  const reconnectLabel = !accountAction ? undefined : failure.ownAccount && cloud ? `Connect your ${AGENT_NAMES[cloud.provider]} account`
    : reason === "auth-required" ? "Reconnect provider account" : "Check provider connection";
  return { message: failure.message, retry, reconnect: accountAction, reconnectLabel, reassign: false };
}
