/** Optional metadata keeps older CLI producers readable. A zero-call result
 * alone is NOT a background receipt: local slash commands also use that shape. */
export interface ClaudeResultOwnership {
  subtype?: unknown;
  is_error?: unknown;
  errors?: unknown;
  terminal_reason?: unknown;
  stop_reason?: unknown;
  result?: unknown;
  num_turns?: unknown;
  result_index?: unknown;
  local_command?: unknown;
  origin?: unknown;
  user_message_uuid?: unknown;
  user_message_uuids?: unknown;
  queued_turn_count?: unknown;
}

function hasCorrelation(event: ClaudeResultOwnership): boolean {
  return (typeof event.user_message_uuid === "string" && event.user_message_uuid.length > 0) ||
    (Array.isArray(event.user_message_uuids) && event.user_message_uuids.some((id) => typeof id === "string" && id.length > 0));
}

/** A queued user send may be folded into an autonomous turn. Its explicit
 * UUID then wins over origin; an unowned notification cannot finish that send. */
export function isUnownedClaudeResult(event: ClaudeResultOwnership): boolean {
  if (hasCorrelation(event)) return false;
  const origin = event.origin;
  const kind = origin && typeof origin === "object" ? (origin as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && kind.length > 0 && kind !== "human" && kind !== "unclassified";
}

/** 0.3.274 batches background notifications into one model call, acknowledging
 * earlier notifications with empty zero-call results. Preserve the active
 * turn/clock on those receipts, but still account for cumulative usage. */
export function isClaudeBackgroundAcknowledgement(event: ClaudeResultOwnership): boolean {
  if (event.subtype !== "success" || event.is_error === true ||
    (Array.isArray(event.errors) && event.errors.some((error) => typeof error === "string" && error.trim())) ||
    (event.terminal_reason != null && event.terminal_reason !== "end_turn") ||
    (event.stop_reason != null && event.stop_reason !== "end_turn") ||
    event.num_turns !== 0 || event.result !== "" || hasCorrelation(event) ||
    (typeof event.local_command === "string" && event.local_command.length > 0)) return false;
  return isUnownedClaudeResult(event) ||
    (typeof event.result_index === "number" && Number.isSafeInteger(event.result_index) && event.result_index >= 0 &&
      typeof event.queued_turn_count === "number" && event.queued_turn_count > 0);
}
