import type { AgentErrorNoticeMessage, AgentMessage } from "@zeros/protocol/agent-messages";
import { isLegacyEnvironmentConnection, isRoutineNativeSleep } from "./renderers/tool-readiness";

const USAGE_PREFIX = "claude-rate-limit:";
const USAGE_PRIORITY = new Map([
  ["Claude usage is available again.", 0],
  ["Claude is using extra usage.", 1],
  ["Claude is nearing its usage limit.", 2],
  ["Claude has reached its included usage limit. Extra usage is available.", 3],
  ["Claude has reached its usage limit. Wait for the limit to reset before retrying.", 4],
]);
const AUTHENTICATION_PREFIX = /^(?:Failed to authenticate\b|Authentication (?:required|failed)\b|OAuth session expired\b|Invalid API key\b|Unauthorized\b|Not (?:logged|signed) in\b)/i;

export function isAuthenticationFailureText(text: string): boolean {
  return typeof text === "string" && AUTHENTICATION_PREFIX.test(text.trim());
}

export function isLegacyAuthenticationNotice(event: AgentMessage): boolean {
  return event.kind === "text" && event.role !== "user" && !event.parentToolId &&
    isAuthenticationFailureText(event.text);
}

/** Only native notice identities qualify. A model quoting the same sentence
 * is ordinary prose. Older persisted feedback remains readable without a migration. */
export function isUsageNotice(event: AgentMessage): boolean {
  if ("parentToolId" in event && event.parentToolId) return false;
  return event.kind === "error_notice"
    ? event.code?.startsWith(USAGE_PREFIX) === true
    : event.kind === "text" && event.role === "agent" &&
      (event.messageId ?? event.id)?.startsWith("claude-feedback-") === true && typeof event.text === "string" && USAGE_PRIORITY.has(event.text.trim());
}

/** One current usage status at the turn tail. Distinct native budgets retain
 * their latest state; recovery for one budget cannot clear another's warning. */
export function turnUsageNotice(events: readonly AgentMessage[]): AgentErrorNoticeMessage | null {
  const current = new Map<string, AgentErrorNoticeMessage>();
  for (const event of events) {
    if (!isUsageNotice(event)) continue;
    if (event.kind === "error_notice") {
      current.delete("legacy");
      current.set(event.code!, event);
    } else if (event.kind === "text") {
      current.set("legacy", {
        id: event.id, kind: "error_notice", createdAt: event.createdAt,
        severity: "warning", recoverable: true, code: `${USAGE_PREFIX}legacy`, message: event.text,
      });
    }
  }
  let selected: AgentErrorNoticeMessage | null = null;
  for (const notice of current.values()) {
    if (!selected || (USAGE_PRIORITY.get(notice.message) ?? 2) >= (USAGE_PRIORITY.get(selected.message) ?? 2))
      selected = notice;
  }
  return selected;
}

/** Root model work establishes progress after a failed attempt. Bookkeeping,
 * child activity and synthetic provider feedback cannot prove recovery. */
export function isProviderWorkEvent(event: AgentMessage): boolean {
  if ("parentToolId" in event && event.parentToolId) return false;
  if (event.kind === "text") {
    return (event.role === "agent" || event.role === "thought") && !event.retracted &&
      !(event.messageId ?? event.id)?.startsWith("claude-feedback-") && !isLegacyAuthenticationNotice(event) &&
      ((typeof event.text === "string" && event.text.trim().length > 0) || event.redacted === true);
  }
  // A late result can create a terminal tool row without its invocation.
  // Its output is not evidence that the model resumed after the failure.
  const invoked = event.kind === "tool" &&
    (event.rawInput != null || event.status === "pending" || event.status === "in_progress");
  return invoked && !isLegacyEnvironmentConnection(event) && !isRoutineNativeSleep(event) && ![
    "model_switch", "mode_switch", "background_task", "compaction", "budget_stop",
  ].includes(event.toolKind ?? "");
}
