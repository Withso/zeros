import { cloudCommandFailureFromCode, decodeCloudCommandFailure } from "@zeros/protocol/cloud-commands";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { ZodError } from "zod";
import { createHash } from "node:crypto";
import { CLOUD_REPLAY_EVENT_TYPES, CloudEventCursorSchema, type CloudEventCursor } from "@zeros/protocol/cloud-events";

export const PROVIDERS = ["claude", "codex", "cursor"] as const;
export type Provider = typeof PROVIDERS[number];
export const STAGES = ["build", "namespace", "control_plane", "authentication", "validation", "mcp", "admission",
  "native_home", "native_canary", "spawn", "initialize", "first_delta", "terminal", "retirement", "receipt"] as const;
const CODES = new Set(["empty_success", "missing_live_delta", "delta_after_terminal", "missing_terminal", "missing_replay",
  "expected_auth_failure", "expected_admission_failure", "receipt_mismatch", "evidence_limit", "no_providers", "invalid_provider",
  "invalid_trace", "turn_timeout", "cleanup_unconfirmed", "terminal_receipt_mismatch", "engine_authentication_failed", "private_mount_namespace_required",
  "namespace_root_required", "private_root_required", "private_pid_namespace_required", "private_proc_view_required", "owner_authorization_required", "engine_start_failed", "engine_ready_timeout", "runtime_build_failed",
  "namespace_launch_failed", "cgroup_unavailable", "fixture_contract_invalid", "fixture_inspection_failed", "tool_bytes_mismatch",
  "tool_evidence_missing", "resume_evidence_missing", "stop_evidence_missing", "operator_input_invalid", "wire_schema_invalid",
  "cloud_actor_authority_rejected", "command_response_invalid", "command_service_unavailable", "invalid_command", "command_conflict",
  "command_context_changed", "command_not_found", "command_limit", "engine_authority_rejected",
  "ubuntu_checksum_invalid", "ubuntu_archive_invalid", "ubuntu_download_failed", "ubuntu_package_install_failed", "engine_identity_missing", "replay_content_mismatch",
  "fixture_terminal_missing", "fixture_terminal_conflict", "fixture_receipt_not_terminal", "fixture_settlement_conflict",
  "renderer_grant_origin_invalid", "renderer_grant_identity_invalid", "renderer_grant_request_invalid", "renderer_grant_invalid",
  "renderer_runtime_unqualified", "renderer_prepare_denied", "renderer_prepare_response_invalid", "renderer_prepare_transport_failed",
  "renderer_prepare_timeout", "renderer_prepare_cancelled", "timing_packet_invalid", "timing_scope_mismatch", "timing_coverage_incomplete",
  "timing_turn_mismatch", "timing_stage_missing", "timing_duplicate_stage", "timing_stage_order_invalid", "timing_calibration_invalid",
  "timing_capability_missing", "renderer_command_invalid", "renderer_command_missing",
  "fixture_measurement_invalid", "ingress_calibration_invalid", "ingress_interval_outside_window", "ingress_details_incomplete"]);
export class HarnessFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "HarnessFailure"; }
}
type FailedObservation = { outcome: "failed"; state: string; resultCode: string | null;
  liveDeltaBytes: number; replayDeltaBytes: number; liveTerminal: boolean; replayTerminal: boolean; frames: number };
/** A rejected case retains its actual typed gate; it can never become success. */
export class TurnAssertionFailure extends HarnessFailure {
  constructor(code: "expected_auth_failure" | "expected_admission_failure", readonly observation: FailedObservation) { super(code); }
}
type ReplayObservation = { liveSequences: number[]; replaySequences: number[]; changedSequences: number[];
  liveTerminal: boolean; replayTerminal: boolean; invalidStream: boolean; liveDeltaBytes: number; replayDeltaBytes: number };
class ReplayEvidenceFailure extends HarnessFailure {
  constructor(readonly replay: ReplayObservation) { super("replay_content_mismatch"); }
}
function knownCode(code: unknown): code is string {
  return typeof code === "string" && (CODES.has(code) || !!decodeCloudCommandFailure(code) || isCloudAgentAdmissionCode(code));
}
/** Error text is never evidence. Retain only known codes and schema field ids. */
export function diagnoseHarnessFailure(error: unknown): { code: string; assertionCode?: string; observation?: FailedObservation; replay?: ReplayObservation; issues?: { code: string; field: string }[] } {
  if (error instanceof ReplayEvidenceFailure) return { code: error.code, replay: error.replay };
  if (error instanceof TurnAssertionFailure) return { code: knownCode(error.observation.resultCode) ? error.observation.resultCode : error.code,
    assertionCode: error.code, observation: error.observation };
  if (error instanceof ZodError) {
    const fields = new Set(["state", "result", "terminal", "resultCode", "commandId", "conversationId", "executionId", "generation",
      "payload", "position", "createdAt", "updatedAt", "version", "revision", "pending", "receipts", "modeRevision", "cloudTurnProtocolVersion",
      "events", "frame", "cursor", "head", "firstRetained", "streamId"]);
    const codes = new Set(["invalid_type", "invalid_value", "invalid_format", "too_big", "too_small", "unrecognized_keys", "invalid_union", "custom"]);
    return { code: "wire_schema_invalid", issues: error.issues.slice(0, 8).map(issue => ({
      code: codes.has(issue.code) ? issue.code : "other", field: !issue.path.length ? "root" :
        typeof issue.path[0] === "string" && fields.has(issue.path[0]) ? issue.path[0] : "other" })) };
  }
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (knownCode(code)) return { code };
  const prefix = error instanceof Error ? error.message.slice(0, 128).split(":", 1)[0] : undefined;
  return { code: knownCode(prefix) ? prefix : "fixture_contract_invalid" };
}
export function selectProviders(values: readonly string[]): Provider[] {
  if (!values.length) throw new HarnessFailure("no_providers");
  if (values.some(value => !(PROVIDERS as readonly string[]).includes(value))) throw new HarnessFailure("invalid_provider");
  return PROVIDERS.filter(value => values.includes(value));
}
export function safeTrace(input: Record<string, unknown>): Record<string, unknown> {
  try {
    // Validate and retain the same primitive sample; no coercible object or
    // changing getter can substitute an unvalidated value into the trace.
    const { stage, status, provider, code } = input;
    if (!(STAGES as readonly unknown[]).includes(stage) || typeof status !== "string" ||
        !["passed", "failed", "pending", "observed"].includes(status))
      throw new HarnessFailure("invalid_trace");
    const result: Record<string, unknown> = { stage, status };
    if (provider !== undefined) {
      if (!(PROVIDERS as readonly unknown[]).includes(provider)) throw new HarnessFailure("invalid_trace");
      result.provider = provider;
    }
    if (code !== undefined) {
      if (!knownCode(code)) throw new HarnessFailure("invalid_trace");
      result.code = code;
    }
    for (const key of ["elapsedMs", "liveDeltaBytes", "replayDeltaBytes", "frames", "count"]) {
      const value = input[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000)
        throw new HarnessFailure("invalid_trace");
      result[key] = value;
    }
    return result;
  } catch {
    throw new HarnessFailure("invalid_trace");
  }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Raw provider output is consumed only in memory. Evidence contains counts,
 * closed failure codes and ownership, never prompt/tool/error excerpts. */
export class TurnEvidence {
  private liveDeltaBytes = 0;
  private replayDeltaBytes = 0;
  private terminal = false;
  private replayTerminal = false;
  private afterTerminal = false;
  private limit = false;
  private frameCount = 0;
  private streamId: string | null = null;
  private floor = 0;
  private replayMismatch = false;
  private readonly liveFingerprints = new Map<number, string>();
  private readonly replayFingerprints = new Map<number, string>();
  private executionId: string | null = null;
  private terminalState: "succeeded" | "failed" | "cancelled" | null = null;
  private terminalCode: string | null = null;
  private terminalFailureKind: string | null = null;
  private replayTerminalState: "succeeded" | "failed" | "cancelled" | null = null;
  private replayTerminalCode: string | null = null;
  private replayTerminalFailureKind: string | null = null;
  toolCalls = 0;
  readonly toolKinds = new Set<string>();
  private readonly limits: { maxBytes: number; maxFrames: number };
  constructor(private readonly owner: { provider: Provider; conversationId: string; commandId: string },
    limits: Partial<{ maxBytes: number; maxFrames: number }> = {}) {
    this.limits = { maxBytes: 2 * 1024 * 1024, maxFrames: 10_000, ...limits };
  }
  begin(cursor: CloudEventCursor): void {
    if (this.frameCount) throw new HarnessFailure("fixture_contract_invalid");
    const parsed = CloudEventCursorSchema.parse(cursor);
    this.streamId = parsed.streamId; this.floor = parsed.sequence;
  }
  private remember(sequence: number, source: "live" | "replay", fields: unknown[]): boolean {
    const fingerprints = source === "live" ? this.liveFingerprints : this.replayFingerprints;
    const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const existing = fingerprints.get(sequence);
    if (existing !== undefined) { if (existing !== digest) this.replayMismatch = true; return false; }
    if (fingerprints.size >= this.limits.maxFrames) { this.limit = true; return false; }
    fingerprints.set(sequence, digest); return true;
  }
  private assertReplayMatch(): void {
    if (this.replayMismatch || this.liveFingerprints.size !== this.replayFingerprints.size ||
      [...this.liveFingerprints].some(([sequence, digest]) => this.replayFingerprints.get(sequence) !== digest))
      throw new ReplayEvidenceFailure({ liveSequences: [...this.liveFingerprints.keys()].slice(0, 32),
        replaySequences: [...this.replayFingerprints.keys()].slice(0, 32),
        changedSequences: [...this.liveFingerprints].filter(([sequence, digest]) => this.replayFingerprints.has(sequence) &&
          this.replayFingerprints.get(sequence) !== digest).map(([sequence]) => sequence).slice(0, 32),
        liveTerminal: this.terminal, replayTerminal: this.replayTerminal, invalidStream: this.replayMismatch,
        liveDeltaBytes: this.liveDeltaBytes, replayDeltaBytes: this.replayDeltaBytes });
  }
  observe(frame: Record<string, unknown>, source: "live" | "replay"): void {
    if (frame.agentId !== this.owner.provider) return;
    // Native exits and other live-only lifecycle messages deliberately carry
    // no journal cursor. They cannot supply transcript or terminal evidence.
    if (!CLOUD_REPLAY_EVENT_TYPES.has(String(frame.type))) return;
    const end = ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(String(frame.type));
    if (end ? frame.requestId !== this.owner.commandId : frame.chatId !== this.owner.conversationId) return;
    const stream = record(frame.cloudStream);
    const cursor = CloudEventCursorSchema.safeParse({ streamId: stream.streamId, sequence: stream.sequence });
    if (!cursor.success || stream.requiresSnapshot === true) { this.replayMismatch = true; return; }
    if (this.streamId === null) this.streamId = cursor.data.streamId;
    if (cursor.data.streamId !== this.streamId) { this.replayMismatch = true; return; }
    if (cursor.data.sequence <= this.floor) return;
    if (typeof frame.executionId === "string") {
      if (this.executionId !== null && this.executionId !== frame.executionId) return;
      this.executionId = frame.executionId;
    }
    this.frameCount += 1;
    if (this.frameCount > (this.limits.maxFrames ?? 10_000)) this.limit = true;
    if (end) {
      if (!this.remember(cursor.data.sequence, source, [frame.type, frame.agentId, frame.requestId,
        frame.executionId, frame.sessionId, frame.stopReason, frame.error, record(frame.failure).kind])) return;
      const state = frame.type === "AGENT_PROMPT_FAILED" ? "failed" : frame.stopReason === "cancelled" ? "cancelled" : "succeeded";
      const code = decodeCloudCommandFailure(frame.error) || isCloudAgentAdmissionCode(frame.error) ? String(frame.error) : null;
      const kind = record(frame.failure).kind;
      const failureKind = typeof kind === "string" && ["auth-required", "cloud-credentials-unavailable", "timeout", "protocol-error", "subprocess-exited",
        "transport-closed", "lifecycle-superseded", "rate-limited", "verification-required", "session-expired"].includes(kind) ? kind : null;
      if (source === "live") {
        this.terminal = true;
        this.terminalState = state; this.terminalCode = code; this.terminalFailureKind = failureKind;
      } else {
        this.replayTerminal = true;
        this.replayTerminalState = state; this.replayTerminalCode = code; this.replayTerminalFailureKind = failureKind;
      }
      return;
    }
    if (frame.type !== "AGENT_SESSION_UPDATE") return;
    const update = record(record(frame.notification).update);
    if (update.sessionUpdate === "tool_call" && source === "live") {
      this.toolCalls += 1;
      if (["read", "edit", "execute"].includes(String(update.kind))) this.toolKinds.add(String(update.kind));
    }
    const content = record(update.content);
    if (update.sessionUpdate !== "agent_message_chunk" || content.type !== "text" || typeof content.text !== "string" || !content.text.trim()) return;
    const bytes = Buffer.byteLength(content.text);
    if (bytes > this.limits.maxBytes) { this.limit = true; return; }
    if (!this.remember(cursor.data.sequence, source, [frame.type, frame.agentId, frame.chatId, frame.executionId,
      record(frame.notification).sessionId, update.sessionUpdate, content.type, content.text])) return;
    if (source === "live") { if (this.terminal) this.afterTerminal = true; this.liveDeltaBytes += bytes; }
    else this.replayDeltaBytes += bytes;
    if (this.liveDeltaBytes + this.replayDeltaBytes > this.limits.maxBytes) this.limit = true;
  }
  finish(receipt: { commandId: string; executionId?: string | null; state: string; resultCode: string | null },
    expected: "success" | "auth-failure" | "admission-failure" | "cancelled") {
    if (this.limit) throw new HarnessFailure("evidence_limit");
    if (receipt.commandId !== this.owner.commandId || this.executionId !== null && receipt.executionId !== this.executionId)
      throw new HarnessFailure("receipt_mismatch");
    const cause = decodeCloudCommandFailure(receipt.resultCode);
    for (const [state, code, kind] of [[this.terminalState, this.terminalCode, this.terminalFailureKind],
      [this.replayTerminalState, this.replayTerminalCode, this.replayTerminalFailureKind]]) {
      if (state !== null && (state !== receipt.state || code !== null && code !== receipt.resultCode ||
        code === null && kind !== null && cloudCommandFailureFromCode(receipt.resultCode)?.kind !== kind))
        throw new HarnessFailure("terminal_receipt_mismatch");
    }
    const unexpected = (code: "expected_auth_failure" | "expected_admission_failure") => new TurnAssertionFailure(code, {
      outcome: "failed", state: ["succeeded", "failed", "cancelled", "uncertain"].includes(receipt.state) ? receipt.state : "unknown",
      resultCode: knownCode(receipt.resultCode) ? receipt.resultCode : null, liveDeltaBytes: this.liveDeltaBytes,
      replayDeltaBytes: this.replayDeltaBytes, liveTerminal: this.terminal, replayTerminal: this.replayTerminal, frames: this.frameCount,
    });
    if (expected === "auth-failure") {
      if (receipt.state !== "failed" || !cause || !["auth_required", "cloud_credential_error"].includes(cause.category))
        throw unexpected("expected_auth_failure");
      if (!this.terminal) throw new HarnessFailure("missing_terminal");
      if (!this.replayTerminal) throw new HarnessFailure("missing_replay");
      this.assertReplayMatch();
      return { outcome: "pre_auth_only" as const, cause, liveDeltaBytes: this.liveDeltaBytes, replayDeltaBytes: this.replayDeltaBytes };
    }
    if (expected === "admission-failure") {
      if (receipt.state !== "failed" || (!isCloudAgentAdmissionCode(receipt.resultCode) && (cause?.stage !== "admission" || cause.category === "rejected")))
        throw unexpected("expected_admission_failure");
      if (!this.terminal) throw new HarnessFailure("missing_terminal");
      if (!this.replayTerminal) throw new HarnessFailure("missing_replay");
      this.assertReplayMatch();
      return { outcome: "pre_auth_only" as const, cause, liveDeltaBytes: this.liveDeltaBytes, replayDeltaBytes: this.replayDeltaBytes };
    }
    if (expected === "cancelled") {
      if (receipt.state !== "cancelled" || !this.toolCalls) throw new HarnessFailure("stop_evidence_missing");
      if (!this.terminal) throw new HarnessFailure("missing_terminal");
      if (!this.replayTerminal) throw new HarnessFailure("missing_replay");
      this.assertReplayMatch();
      return { outcome: "passed" as const, liveDeltaBytes: this.liveDeltaBytes, replayDeltaBytes: this.replayDeltaBytes };
    }
    if (!this.terminal) throw new HarnessFailure("missing_terminal");
    if (this.afterTerminal) throw new HarnessFailure("delta_after_terminal");
    if (!this.liveDeltaBytes && !this.replayDeltaBytes) throw new HarnessFailure("empty_success");
    if (!this.liveDeltaBytes) throw new HarnessFailure("missing_live_delta");
    if (!this.replayDeltaBytes || !this.replayTerminal) throw new HarnessFailure("missing_replay");
    if (receipt.state !== "succeeded" || receipt.resultCode !== null) throw new HarnessFailure("receipt_mismatch");
    this.assertReplayMatch();
    return { outcome: "passed" as const, liveDeltaBytes: this.liveDeltaBytes, replayDeltaBytes: this.replayDeltaBytes };
  }
}
export async function runWithDeadline<T>(work: (signal: AbortSignal) => Promise<T>, cleanup: () => Promise<void>, timeoutMs: number, cleanupMs = 10_000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000 ||
    !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 60_000) throw new HarnessFailure("operator_input_invalid");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new HarnessFailure("turn_timeout"));
  }, timeoutMs); });
  let outcome: { succeeded: true; value: T } | { succeeded: false; error: unknown };
  try { outcome = { succeeded: true, value: await Promise.race([work(controller.signal), timeout]) }; }
  catch (error) { outcome = { succeeded: false, error }; }
  finally { clearTimeout(timer); controller.abort(); }
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([cleanup(), new Promise<never>((_, reject) => {
    cleanupTimer = setTimeout(() => reject(new HarnessFailure("cleanup_unconfirmed")), cleanupMs);
  })]); } catch { throw new HarnessFailure("cleanup_unconfirmed"); }
  finally { clearTimeout(cleanupTimer); }
  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
}
