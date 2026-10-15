import { describe, expect, it } from "vitest";
import { DetachedAgentOfflineCheckSchema, DetachedAgentTaskRowSchema,
  type DetachedAgentOfflineCheck } from "../zeros-dev/detached-agent-proof-contract";
import { HourlySchema } from "../zeros-dev/hourly-contract";
import { InfrastructureSchema } from "../zeros-dev/infrastructure-contract";
import { Gate0Schema } from "../zeros-dev/gate0-contract";

function report(): DetachedAgentOfflineCheck {
  const digest = "a".repeat(64);
  return { schema: "zeros.detached-agent-offline-check/v1", validation: "consistent", qualification: "not_performed",
    authority: "not_verified", nativeDispatches: null, inputSha256: digest, scopeSha256: digest, commandSha256: digest,
    beforeContextSha256: digest, afterContextSha256: digest, historySha256: digest, replaySha256: digest,
    launchAuth: { observedAtMs: 1000, expiresAtMs: 301_000 },
    detached: { startedAtMs: 4000, completedAtMs: 1_864_000, durationMs: 1_860_099.962993 },
    nativeTurn: { startedAtMs: 1000, endedAtMs: 1_865_000, durationMs: 1_864_000 },
    task: { durationMs: 1_860_000, rowCount: 32, maxHeartbeatGapMs: 60_000, programSha256: digest, outputSha256: digest },
    coverage: { kind: "bounded_task_observations", fullChat: "not_proven", baselineRows: 6, immutableRows: 4,
      mutableRows: 2, finalRows: 7, replayEvents: 3 } };
}

describe("detached agent offline report contract", () => {
  it("keeps independent timing observations and missing physical dispatch telemetry unchanged", () => {
    const value = report(), parsed = DetachedAgentOfflineCheckSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(parsed.nativeDispatches).toBeNull();
    expect(parsed.detached.durationMs).not.toBe(parsed.detached.completedAtMs - parsed.detached.startedAtMs);
  });
  it.each(["success", "signature", "deviceKey", "serverSessionVerified", "providerExpiresAt", "prompts", "messages"])(
    "rejects authority, qualification or raw-content field %s", field => {
      expect(DetachedAgentOfflineCheckSchema.safeParse({ ...report(), [field]: true }).success).toBe(false);
    });
  it.each(["nativeDispatches", "authority", "qualification", "fullChat"])("never promotes the report through %s", key => {
    const value = report();
    const invalid = key === "fullChat" ? { ...value, coverage: { ...value.coverage, fullChat: "complete" } }
      : { ...value, [key]: key === "nativeDispatches" ? 0 : "verified" };
    expect(DetachedAgentOfflineCheckSchema.safeParse(invalid).success).toBe(false);
  });
  it.each(["sum", "missing_rows", "native_time", "wall_order", "missing_replay"])("refuses inconsistent %s measurements", kind => {
    const value = report();
    if (kind === "sum") value.coverage.mutableRows++;
    if (kind === "missing_rows") value.coverage.finalRows = 5;
    if (kind === "native_time") value.nativeTurn.durationMs++;
    if (kind === "wall_order") value.detached.completedAtMs = 0;
    if (kind === "missing_replay") value.coverage.replayEvents = 0;
    expect(DetachedAgentOfflineCheckSchema.safeParse(value).success).toBe(false);
  });
  it("is not a legacy profile result even when a caller adds its completion field", () => {
    for (const schema of [HourlySchema, InfrastructureSchema, Gate0Schema]) {
      expect(schema.safeParse(report()).success).toBe(false);
      expect(schema.safeParse({ ...report(), complete: true }).success).toBe(false);
    }
  });
  it("does not default unavailable telemetry to zero", () => {
    const { nativeDispatches: _missing, ...value } = report();
    expect(DetachedAgentOfflineCheckSchema.safeParse(value).success).toBe(false);
  });
  it("bounds task row numbers and accepts no extra authority assertion", () => {
    const row = { n: 0, ms: 0, run: "00000000-0000-4000-8000-000000000001", nonce: "00000000-0000-4000-8000-000000000002" };
    expect(DetachedAgentTaskRowSchema.parse(row)).toEqual(row);
    for (const value of [{ ...row, n: 32 }, { ...row, ms: -1 }, { ...row, authority: true }])
      expect(DetachedAgentTaskRowSchema.safeParse(value).success).toBe(false);
  });
});
