// Pure evidence checks; no actual latency/provider qualification.
import { describe, expect, it } from "vitest";
import { summarizeTurnTimings, TimingEvidenceFailure } from "../cloud-workspace-validation/cloud-agent-e2e/measurement";
import { RendererGrantError } from "../cloud-workspace-validation/cloud-agent-e2e/renderer-grant";
import { diagnoseHarnessFailure, safeTrace } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";

const org = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const engine = "33333333-3333-4333-8333-333333333333";
const clock = "44444444-4444-4444-8444-444444444444";
const command = "55555555-5555-4555-8555-555555555555";
const clientClock = "66666666-6666-4666-8666-666666666666";
const priorCommand = "77777777-7777-4777-8777-777777777777";
const expected = { organizationId: org, workspaceId: workspace, generation: 1, engineInstanceId: engine,
  conversationId: "fixture-chat", commandId: command, turnId: "fixture-turn", executionId: "fixture-execution",
  provider: "codex" as const, mode: "legacy" as const, bootId: null, writerEpoch: null };
const calibration = { clientClockId: clientClock, sendAtMs: 400, beforeAtMs: 500, afterAtMs: 504 };
function packet() {
  return { version: 1, ...expected, clockId: clock, sampledAtMs: 200,
    coverage: { truncated: false, retired: false, unknown: false },
    records: [
      { stage: "engine_received", atMs: 100 }, { stage: "dispatch_committed", atMs: 110 },
      { stage: "native_write", atMs: 111 }, { stage: "first_delta", atMs: 113, outputKind: "text" },
      { stage: "native_acceptance_ack", atMs: 114 }, { stage: "terminal_committed", atMs: 116 },
    ].map((mark, index) => ({ sequence: index + 1, commandId: command, conversationId: expected.conversationId,
      turnId: expected.turnId, executionId: expected.executionId, provider: expected.provider, ...mark })) };
}
// A real packet has no top-level turn/command/provider selectors.
function wire() { const value = packet(); const { commandId: _command, turnId: _turn, executionId: _execution,
  provider: _provider, ...actual } = value; return actual; }

describe("bounded correlated R7 timing evidence", () => {
  it("reports bracket uncertainty instead of directly subtracting process clocks", () => {
    const result = summarizeTurnTimings(wire(), expected, calibration);
    expect(result.calibrationUncertaintyMs).toBe(4);
    expect(result.sendToNativeWriteMs).toEqual({ min: 11, max: 15 });
    expect(result.engineToNativeWriteMs).toBe(11);
    expect(result.engineToNativeAcceptanceMs).toBe(14);
    expect(result.sendToFirstTextMs).toEqual({ min: 13, max: 17 });
    expect(result.sendToFirstToolMs).toBeNull();
    expect(result.outputBeforeObservedNativeAck).toBe(true);
    expect(result.nativeAcceptanceToFirstOutputMs).toBe(-1);
    expect(result.foregroundDependencyCoverage).toBe("unavailable");
    expect(result.foregroundCpRequests).toBeNull();
  });
  it("does not convert an SDK run creation into a native acceptance ACK", () => {
    const value = wire(); value.records[4].stage = "sdk_run_created";
    const result = summarizeTurnTimings(value, expected, calibration);
    expect(result.sendToSdkRunCreatedMs).toEqual({ min: 14, max: 18 });
    expect(result.sendToNativeAcceptanceMs).toBeNull();
    expect(result.nativeAcceptanceToFirstOutputMs).toBeNull();
  });
  it("keeps first tool output separate from first text", () => {
    const value = wire(); value.records[3].outputKind = "tool";
    const result = summarizeTurnTimings(value, expected, calibration);
    expect(result.sendToFirstToolMs).toEqual({ min: 13, max: 17 });
    expect(result.sendToFirstTextMs).toBeNull();
  });
  it("does not hide a shared CP flight begun before engine receipt", () => {
    const value = wire();
    value.records.unshift(Object.assign({ ...value.records[0], stage: "cp_request_started", atMs: 99 },
      { dependency: "credentials.validate" }));
    value.records = value.records.map((row, index) => ({ ...row, sequence: index + 1 }));
    const result = summarizeTurnTimings(value, expected, calibration);
    expect(result.engineToNativeAcceptanceMs).toBe(14);
    expect(result.foregroundDependencyCoverage).toBe("unavailable");
    expect(result.foregroundCpRequests).toBeNull();
  });
  it("retains early typed auth failure without claiming prompt/native receipt", () => {
    const value = wire(); value.records = value.records.filter(row => row.stage === "engine_received" ||
      row.stage === "dispatch_committed" || row.stage === "terminal_committed");
    value.records.splice(2, 0, { ...value.records[1], sequence: 5, stage: "typed_auth_failure", atMs: 115 });
    const result = summarizeTurnTimings(value, expected, calibration);
    expect(result.sendToTypedAuthFailureMs).toEqual({ min: 15, max: 19 });
    expect(result.sendToNativeWriteMs).toBeNull();
    expect(result.sendToNativeAcceptanceMs).toBeNull();
    expect(result.sendToFirstTextMs).toBeNull();
  });
  it("refuses unclassified first output instead of certifying a first-text latency", () => {
    const value = wire(); delete value.records[3].outputKind;
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_packet_invalid");
  });
  it.each(["truncated", "retired", "unknown"] as const)("refuses %s coverage", field => {
    const value = wire(); value.coverage[field] = true;
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_coverage_incomplete");
  });
  it.each(["organizationId", "workspaceId", "engineInstanceId"] as const)("rejects a foreign %s", field => {
    const value = wire(); value[field] = priorCommand;
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_scope_mismatch");
  });
  it("rejects a different generation even on the same engine identity", () => {
    expect(() => summarizeTurnTimings({ ...wire(), generation: 2 }, expected, calibration)).toThrow("timing_scope_mismatch");
  });
  it("rejects an internally consistent foreign conversation", () => {
    const value = wire(); value.conversationId = "foreign-chat";
    value.records = value.records.map(row => ({ ...row, conversationId: "foreign-chat" }));
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_scope_mismatch");
  });
  it("rejects an unrequested mode even with syntactically valid boot fields", () => {
    const value = { ...wire(), mode: "boot-owner-v1", bootId: clock, writerEpoch: clientClock };
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_scope_mismatch");
  });
  it.each(["bootId", "writerEpoch"] as const)("rejects a stale %s in the same generation", field => {
    const bootExpected = { ...expected, mode: "boot-owner-v1" as const, bootId: clock, writerEpoch: clientClock };
    const value = { ...wire(), mode: "boot-owner-v1", bootId: clock, writerEpoch: clientClock, [field]: priorCommand };
    expect(() => summarizeTurnTimings(value, bootExpected, calibration)).toThrow("timing_scope_mismatch");
  });
  it("cannot borrow a prior turn's native or text markers", () => {
    const value = wire(); value.records = value.records.map(row => ({ ...row, commandId: priorCommand, turnId: "prior-turn" }));
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_stage_missing");
  });
  it.each(["turnId", "executionId", "provider"] as const)("rejects changed %s for this command", field => {
    const value = wire(); value.records[3] = { ...value.records[3], [field]: field === "provider" ? "claude" : "foreign-turn" };
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_turn_mismatch");
  });
  it("refuses duplicate stage proof even when both timestamps are plausible", () => {
    const value = wire(); value.records.splice(4, 0, { ...value.records[2], sequence: 4 });
    value.records = value.records.map((row, index) => ({ ...row, sequence: index + 1 }));
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_duplicate_stage");
  });
  it("rejects an engine dispatch marker preceding receipt", () => {
    const value = wire(); value.records[1].atMs = 99;
    expect(() => summarizeTurnTimings(value, expected, calibration)).toThrow("timing_stage_order_invalid");
  });
  it("rejects raw material/prose added to the inspected packet with a closed error", () => {
    const value = { ...wire(), material: "private-sentinel" };
    let error: unknown; try { summarizeTurnTimings(value, expected, calibration); } catch (failure) { error = failure; }
    expect(String(error)).toContain("timing_packet_invalid");
    expect(JSON.stringify(error) + String(error)).not.toContain("private-sentinel");
  });
  it.each([{ ...calibration, beforeAtMs: 505 }, { ...calibration, afterAtMs: Infinity },
    { ...calibration, sendAtMs: 600 }, { ...calibration, afterAtMs: 60_000 }])("refuses invalid/unbounded calibration", invalid => {
    expect(() => summarizeTurnTimings(wire(), expected, invalid)).toThrow("timing_calibration_invalid");
  });
});

// Once wired into the operator, every new closed failure must retain its code.
// A generic fixture error would hide the actual failed measurement stage.
describe("operator measurement diagnostics", () => {
  it.each(["renderer_grant_origin_invalid", "renderer_grant_identity_invalid", "renderer_grant_request_invalid",
    "renderer_grant_invalid", "renderer_runtime_unqualified", "renderer_prepare_denied", "renderer_prepare_response_invalid",
    "renderer_prepare_transport_failed", "renderer_prepare_timeout", "renderer_prepare_cancelled"] as const)("retains closed prepare failure %s", code => {
      expect(diagnoseHarnessFailure(new RendererGrantError(code))).toEqual({ code });
      expect(safeTrace({ stage: "receipt", status: "failed", code })).toEqual({ stage: "receipt", status: "failed", code });
    });
  it.each(["timing_packet_invalid", "timing_scope_mismatch", "timing_coverage_incomplete", "timing_turn_mismatch",
    "timing_stage_missing", "timing_duplicate_stage", "timing_stage_order_invalid", "timing_calibration_invalid"] as const)("retains closed timing failure %s", code => {
      expect(diagnoseHarnessFailure(new TimingEvidenceFailure(code))).toEqual({ code });
      expect(safeTrace({ stage: "receipt", status: "failed", code })).toEqual({ stage: "receipt", status: "failed", code });
    });
  it("refuses a coercible status object without retaining its extra fields", () => {
    const status = { toString: () => "passed", material: "private-sentinel" };
    expect(() => safeTrace({ stage: "receipt", status })).toThrow("invalid_trace");
  });
  it("samples a primitive status once before reconstructing the trace", () => {
    let reads = 0;
    const input = { stage: "receipt", get status() { return ++reads === 1 ? "passed" : "private-sentinel"; } };
    const result = safeTrace(input);
    expect(result).toEqual({ stage: "receipt", status: "passed" });
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-sentinel");
  });
  it.each([["stage", "receipt"], ["provider", "claude"], ["code", "wire_schema_invalid"], ["count", 1]] as const)("samples %s once before retaining it", (field, value) => {
      let reads = 0;
      const input = { stage: "receipt", status: "passed" };
      Object.defineProperty(input, field, { get: () => ++reads === 1 ? value : "private-sentinel" });
      expect(safeTrace(input)).toEqual({ stage: "receipt", status: "passed", [field]: value });
      expect(reads).toBe(1);
    });
  it("closes a throwing field getter without retaining its message", () => {
    const input = { stage: "receipt", get status(): string { throw new Error("private-sentinel"); } };
    let failure: unknown;
    try { safeTrace(input); } catch (error) { failure = error; }
    expect(String(failure)).toContain("invalid_trace");
    expect(String(failure) + JSON.stringify(failure)).not.toContain("private-sentinel");
  });
});
