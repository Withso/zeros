import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Evidence, EvidenceEventSchema } from "../zeros-dev/evidence";

const probeId = randomUUID();
const phaseRows = [
  { phase: "sdk_device_session", outcome: "ok", durationMs: 2, sdk: { probeId } },
  { phase: "sdk_runtime_connect", outcome: "ok", durationMs: 3, sdk: { probeId } },
  { phase: "sdk_runtime_ready", outcome: "ok", durationMs: 5, sdk: { probeId, route: "direct" } },
  { phase: "sdk_device_stream_ready", outcome: "ok", durationMs: 7, sdk: { probeId, organizationCoverage: "enabled" } },
];

describe("closed SDK canary evidence", () => {
  it.each(phaseRows)("retains $phase timing and its positive proof without coercion", row => {
    expect(EvidenceEventSchema.safeParse(row).success).toBe(true);
    expect(EvidenceEventSchema.parse(row)).toEqual(row);
  });

  it("records flag-off discovery as skipped, independently of legacy runtime success", () => {
    const output: unknown[] = [], evidence = new Evidence(randomUUID(), row => output.push(row));
    const skip = { phase: "sdk_runtime_connect", outcome: "skipped", durationMs: 12, sdk: { probeId, skip: "legacy_discovery" } };
    expect(() => evidence.emit(skip as never)).not.toThrow();
    expect(evidence.events).toEqual([skip]);
    expect(output).toEqual([{ schema: "zeros.dev-evidence/v1", runId: evidence.runId, ...skip }]);
  });

  it.each([
    { ...phaseRows[2], sdk: { probeId } },
    { ...phaseRows[2], sdk: { probeId, route: "relay" } },
    { ...phaseRows[3], sdk: { probeId } },
    { ...phaseRows[1], outcome: "skipped" },
    { ...phaseRows[1], sdk: { probeId, skip: "legacy_discovery" } },
    { ...phaseRows[1], outcome: "pending" },
    { ...phaseRows[1], sdk: { probeId, url: "wss://private.invalid/ws" } },
    { ...phaseRows[1], sdk: { probeId, ticket: "private-ticket" } },
    { ...phaseRows[1], sdk: { probeId, proof: "private-proof" } },
    { ...phaseRows[1], sdk: { probeId, token: "private-token" } },
    { ...phaseRows[1], sdk: { probeId, message: "private-message" } },
    { ...phaseRows[1], sdk: { probeId, skip: "server-controlled-code" }, outcome: "skipped" },
    { ...phaseRows[1], phase: "runtime_connect" },
    { ...phaseRows[1], durationMs: -1 },
    { ...phaseRows[1], durationMs: Number.POSITIVE_INFINITY },
  ])("refuses inconsistent coverage or an open evidence field %#", row => {
    expect(EvidenceEventSchema.safeParse(row).success).toBe(false);
  });

  it("keeps old signed event bytes unchanged and does not add SDK coverage", () => {
    const old = { phase: "runtime_connect", outcome: "ok", durationMs: 12 };
    expect(JSON.stringify(EvidenceEventSchema.parse(old))).toBe(JSON.stringify(old));
    expect(EvidenceEventSchema.parse(old)).not.toHaveProperty("sdk");
  });
});
