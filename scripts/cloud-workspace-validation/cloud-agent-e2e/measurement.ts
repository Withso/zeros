import { z } from "zod";
import { CloudAgentTurnTimingsSchema, type CloudAgentTurnTimingRecord } from "@zeros/protocol/cloud-events";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const expectedSchema = z.object({ organizationId: z.uuid(), workspaceId: z.uuid(), generation: z.number().int().positive(),
  engineInstanceId: z.uuid(), conversationId: identity, commandId: z.uuid(), turnId: identity,
  executionId: identity.nullable(), provider: z.enum(["claude", "codex", "cursor"]), mode: z.enum(["legacy", "boot-owner-v1"]),
  bootId: z.uuid().nullable(), writerEpoch: z.uuid().nullable() }).strict();
const calibrationSchema = z.object({ clientClockId: z.uuid(), sendAtMs: amount, beforeAtMs: amount, afterAtMs: amount }).strict();
type Expected = z.infer<typeof expectedSchema>;
type Calibration = z.infer<typeof calibrationSchema>;
type Range = { min: number; max: number };
type FailureCode = "timing_packet_invalid" | "timing_scope_mismatch" | "timing_coverage_incomplete" |
  "timing_turn_mismatch" | "timing_stage_missing" | "timing_duplicate_stage" | "timing_stage_order_invalid" |
  "timing_calibration_invalid";
export class TimingEvidenceFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "TimingEvidenceFailure"; }
}
function fail(code: FailureCode): never { throw new TimingEvidenceFailure(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown, code: FailureCode): T {
  try { const result = schema.safeParse(value); if (result.success) return result.data; } catch {}
  return fail(code);
}

/** Pure evidence validation. A packet must come from authenticated opt-in
 * inspection; this function cannot manufacture that authority or coverage.
 * A bracket bounds the process-clock offset rather than assuming equal origins.
 * CP marks without real producer/ingress spans never certify foreground zero. */
export function summarizeTurnTimings(packet: unknown, ownership: Expected, bracket: Calibration) {
  const value = parse(CloudAgentTurnTimingsSchema, packet, "timing_packet_invalid");
  const expected = parse(expectedSchema, ownership, "timing_scope_mismatch");
  const calibration = parse(calibrationSchema, bracket, "timing_calibration_invalid");
  if (calibration.sendAtMs > calibration.beforeAtMs || calibration.beforeAtMs > calibration.afterAtMs ||
      calibration.afterAtMs - calibration.beforeAtMs > 5000) fail("timing_calibration_invalid");
  for (const key of ["organizationId", "workspaceId", "generation", "engineInstanceId", "conversationId", "mode", "bootId", "writerEpoch"] as const)
    if (value[key] !== expected[key]) fail("timing_scope_mismatch");
  if (Object.values(value.coverage).some(Boolean)) fail("timing_coverage_incomplete");
  const rows = value.records.filter(row => row.commandId === expected.commandId);
  if (rows.some(row => row.turnId !== expected.turnId || row.executionId !== expected.executionId || row.provider !== expected.provider))
    fail("timing_turn_mismatch");
  const stages = new Map<CloudAgentTurnTimingRecord["stage"], CloudAgentTurnTimingRecord>();
  for (const row of rows) {
    if (row.stage === "cp_request_started" || row.stage === "cp_request_finished") continue;
    if (stages.has(row.stage)) fail("timing_duplicate_stage");
    stages.set(row.stage, row);
  }
  const received = stages.get("engine_received"), dispatched = stages.get("dispatch_committed"), terminal = stages.get("terminal_committed");
  if (!received || !dispatched || !terminal) fail("timing_stage_missing");
  if (received.atMs > dispatched.atMs || dispatched.atMs > terminal.atMs ||
      rows.some(row => !row.dependency && (row.atMs < received.atMs || row.atMs > terminal.atMs))) fail("timing_stage_order_invalid");
  const accepted = stages.get("accepted");
  if (accepted && (accepted.atMs < received.atMs || accepted.atMs > dispatched.atMs)) fail("timing_stage_order_invalid");
  for (const stage of ["native_write", "native_acceptance_ack", "sdk_run_created", "first_delta", "typed_auth_failure"] as const) {
    const row = stages.get(stage); if (row && row.atMs < dispatched.atMs) fail("timing_stage_order_invalid");
  }
  const output = stages.get("first_delta"), ack = stages.get("native_acceptance_ack");
  const outputKind = output?.outputKind;
  if (output && outputKind !== "text" && outputKind !== "tool") fail("timing_packet_invalid");
  const offsetMin = calibration.beforeAtMs - value.sampledAtMs, offsetMax = calibration.afterAtMs - value.sampledAtMs;
  const sinceSend = (row: CloudAgentTurnTimingRecord | undefined): Range | null => {
    if (!row) return null;
    const min = row.atMs + offsetMin - calibration.sendAtMs, max = row.atMs + offsetMax - calibration.sendAtMs;
    if (max < 0) fail("timing_stage_order_invalid");
    return { min: Math.max(0, min), max };
  };
  const engineDuration = (row: CloudAgentTurnTimingRecord | undefined): number | null => row ? row.atMs - received.atMs : null;
  return {
    version: 1 as const, calibrationUncertaintyMs: calibration.afterAtMs - calibration.beforeAtMs,
    clocks: { clientClockId: calibration.clientClockId, engineClockId: value.clockId,
      clientBeforeAtMs: calibration.beforeAtMs, clientAfterAtMs: calibration.afterAtMs, engineSampledAtMs: value.sampledAtMs },
    sendToEngineMs: sinceSend(received), sendToNativeWriteMs: sinceSend(stages.get("native_write")),
    sendToNativeAcceptanceMs: sinceSend(ack), sendToSdkRunCreatedMs: sinceSend(stages.get("sdk_run_created")),
    sendToFirstTextMs: outputKind === "text" ? sinceSend(output) : null,
    sendToFirstToolMs: outputKind === "tool" ? sinceSend(output) : null,
    sendToTypedAuthFailureMs: sinceSend(stages.get("typed_auth_failure")),
    engineToNativeWriteMs: engineDuration(stages.get("native_write")), engineToNativeAcceptanceMs: engineDuration(ack),
    engineToFirstOutputMs: engineDuration(output), engineToTypedAuthFailureMs: engineDuration(stages.get("typed_auth_failure")),
    nativeAcceptanceToFirstOutputMs: output && ack ? output.atMs - ack.atMs : null,
    outputBeforeObservedNativeAck: output && ack ? output.atMs < ack.atMs : null,
    foregroundDependencyCoverage: "unavailable" as const, foregroundCpRequests: null,
  };
}
