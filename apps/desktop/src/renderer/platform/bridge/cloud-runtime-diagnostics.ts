/** Only metadata observed on an already-authorized cloud connection enters
 * the desktop log store. Never forward raw engine logs, stderr, snapshots or
 * transcript content. Older engines need no new command or capability. */
export interface CloudDiagnosticScope {
  organizationId: string;
  workspaceId: string;
  generation: number;
  authorityEpoch: number;
  engineInstanceId: string;
  connectionSequence: number;
  channel: string;
}

type Fields = Record<string, string | number | null>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_KINDS = ["timeout", "auth-required", "verification-required", "cloud-credentials-unavailable",
  "subprocess-exited", "protocol-error", "transport-closed", "lifecycle-superseded", "rate-limited",
  "design-protection-failed", "session-expired"];
const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled",
  "budget_exhausted", "blocking_limit", "prompt_too_long"];
const AGENT_TYPES = new Set(["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED", "AGENT_SESSION_CLOSED",
  "AGENT_AGENT_INITIALIZED", "AGENT_SESSION_UPDATE", "AGENT_STEERED", "AGENT_PROMPT_COMPLETE",
  "AGENT_PROMPT_FAILED", "AGENT_ERROR", "AGENT_AGENT_EXITED", "AGENT_PERMISSION_REQUEST", "AGENT_QUESTION_REQUEST"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function closed(value: unknown, choices: readonly string[]): string {
  return typeof value === "string" && choices.includes(value) ? value : "other";
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

/** The wire envelope is permissive for rolling upgrades. Independently select
 * every exported field; even a recognized frame may carry arbitrary text. */
function metadata(value: unknown): Fields | null {
  const frame = record(value);
  if (frame.type === "ENGINE_READY") return { type: frame.type,
    protocolVersion: integer(frame.protocolVersion, 65_535), minProtocolVersion: integer(frame.minProtocolVersion, 65_535) };
  if (frame.type === "ENGINE_ERROR") return { type: frame.type,
    errorClass: closed(frame.name, ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]) };
  if (typeof frame.type !== "string" || !AGENT_TYPES.has(frame.type)) return null;

  const notification = record(frame.notification), update = record(notification.update), session = record(frame.session);
  // Turn state is engine-owned and content-free. Text/tool chunks, provider
  // bindings and every unknown update are intentionally absent from logs.
  if (frame.type === "AGENT_SESSION_UPDATE" && update.sessionUpdate !== "turn_state") return null;
  const fields: Fields = {
    type: frame.type, agentId: closed(frame.agentId, ["claude", "codex", "cursor"]),
    executionId: uuid(frame.executionId ?? frame.sessionId ?? notification.sessionId ?? session.sessionId),
    requestId: uuid(frame.requestId), conversationId: uuid(frame.chatId),
  };
  if (frame.type === "AGENT_SESSION_UPDATE") {
    fields.state = closed(update.state, ["running", "completed", "failed", "cancelled"]);
    fields.turnId = uuid(update.turnId);
    fields.stopReason = closed(update.stopReason, STOP_REASONS);
  }
  if (frame.type === "AGENT_PROMPT_COMPLETE") fields.stopReason = closed(frame.stopReason, STOP_REASONS);
  if (frame.type === "AGENT_STEERED") {
    // Missing outcome is a legacy acknowledgement; do not invent newer proof.
    fields.outcome = closed(frame.outcome, ["delivered", "queued", "interrupted"]);
    fields.turnId = uuid(frame.turnId);
  }
  if (frame.type === "AGENT_PROMPT_FAILED" || frame.type === "AGENT_ERROR") {
    const failure = record(frame.failure);
    fields.failureKind = closed(failure.kind, FAILURE_KINDS);
    fields.stage = closed(failure.stage, ["initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode"]);
  }
  if (frame.type === "AGENT_AGENT_EXITED") {
    fields.exitCode = integer(frame.code, 255);
    fields.signal = closed(frame.signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGHUP", "SIGPIPE"]);
  }
  return fields;
}

/** Per-client fixed bounds, reset by observed traffic without polling. The
 * shared renderer queue and on-disk rotation/export caps remain in force too.
 * Counts use only closed event/state labels, never remote IDs as map keys. */
export class CloudRuntimeDiagnostics {
  private windowStart = -Infinity;
  private count = 0;
  private counts = new Map<string, number>();
  private suppressed = 0;

  observe(frame: unknown, scope: CloudDiagnosticScope, log: (line: string) => void): void {
    // Diagnostics cannot change dispatch, readiness or listener delivery, even
    // if a host logger throws. No diagnostic failure is itself logged.
    try {
      const fields = metadata(frame);
      if (!fields) return;
      const now = performance.now();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now; this.count = 0; this.counts.clear();
      }
      const key = `${fields.type}:${fields.state ?? ""}`;
      const count = this.counts.get(key) ?? 0;
      if (this.count >= 64 || count >= 8) {
        this.suppressed = Math.min(this.suppressed + 1, Number.MAX_SAFE_INTEGER);
        return;
      }
      const line = "[Zeros cloud runtime] " + JSON.stringify({ ...scope, ...fields, suppressed: this.suppressed });
      // All selected strings are closed labels or UUIDs; this final bound is
      // defensive against future field expansion. Never cut a JSON record.
      if (new TextEncoder().encode(line).byteLength > 1_536) return;
      this.count++; this.counts.set(key, count + 1); this.suppressed = 0;
      log(line);
    } catch { /* best-effort observation only */ }
  }
}
