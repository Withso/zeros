import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdmissionObservationSchema } from "../zeros-dev/admission-observation";
import { Evidence } from "../zeros-dev/evidence";
import { diagnosticEvidence, ZerosDevError } from "../zeros-dev/errors";

const firstFailure = { status: 503 as const, code: "cloud_runtime_temporarily_unavailable" as const,
  phase: "provider_endpoint" as const, retryAfterMs: 1000 };
const observation = { sequence: 1, firstFailure, retryCount: 1,
  retries: [{ ...firstFailure, attempt: 2 as const, delayMs: 1000 }] };

describe("public admission evidence", () => {
  it.each([
    { ...observation, retryCount: 0 }, { ...observation, retries: [{ ...observation.retries[0], attempt: 3 }] },
    { ...observation, retries: [{ ...observation.retries[0], delayMs: 2000 }] },
    { ...observation, firstFailure: { ...firstFailure, status: 500 } },
    { ...observation, firstFailure: { ...firstFailure, phase: "grant" } },
    { ...observation, firstFailure: { ...firstFailure, retryAfterMs: 999 } },
    { ...observation, firstFailure: { ...firstFailure, message: "synthetic-private" } },
    { ...observation, retries: [{ ...observation.retries[0], token: "synthetic-private" }] },
  ])("refuses untrusted or internally inconsistent retry receipts", candidate => {
    expect(AdmissionObservationSchema.safeParse(candidate).success).toBe(false);
    const error = new ZerosDevError("runtime_unavailable", undefined, undefined, undefined, undefined, candidate as never);
    expect(diagnosticEvidence(error)).not.toHaveProperty("admission");
    expect(JSON.stringify(error)).not.toContain("synthetic-private");
  });
  it("keeps copies of the original failure on success and failure without exposing an error body", async () => {
    const rows: unknown[] = [], evidence = new Evidence(randomUUID(), row => rows.push(row), () => 42);
    await evidence.step("runtime_connect", async () => ({ admission: observation }), value => value.admission);
    const error = new ZerosDevError("runtime_unavailable", undefined, undefined, undefined, undefined, observation);
    observation.retries[0]!.delayMs = 2000;
    try {
      await expect(evidence.step("runtime_connect", async () => { throw error; })).rejects.toBe(error);
      expect(rows).toEqual([
        expect.objectContaining({ outcome: "ok", admission: expect.objectContaining({ retryCount: 1 }) }),
        expect.objectContaining({ outcome: "failed", admission: expect.objectContaining({ retries: [expect.objectContaining({ delayMs: 1000 })] }) }),
      ]);
    } finally { observation.retries[0]!.delayMs = 1000; }
  });
});
