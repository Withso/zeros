import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Evidence, EvidenceEventSchema } from "../zeros-dev/evidence";
import { diagnosticEvidence, ZerosDevError } from "../zeros-dev/errors";

describe("closed native proof predicates", () => {
  it("retains the exact closed predicate without copying an exception body", async () => {
    const rows: unknown[] = [], evidence = new Evidence(randomUUID(), row => rows.push(row));
    const error = new ZerosDevError("detached_proof_incomplete", undefined, undefined, undefined, undefined, undefined, undefined,
      { predicate: "pty_create_unavailable" });
    await expect(evidence.step("detached_native_proof", async () => { throw error; })).rejects.toBe(error);
    expect(rows[0]).toMatchObject({ code: "detached_proof_incomplete", nativeProof: { predicate: "pty_create_unavailable" } });
    expect(error.message).toBe("zeros_dev_detached_proof_incomplete");
  });

  it.each([{}, { predicate: "synthetic-private-error" }, { predicate: "pty_exit", output: "synthetic-private-output" }])(
    "discards unrecognized or extra native diagnostic fields", value => {
      const error = Object.assign(new ZerosDevError("detached_proof_incomplete"), { nativeProof: value });
      expect(diagnosticEvidence(error)).toEqual({});
      expect(EvidenceEventSchema.safeParse({ phase: "detached_native_proof", outcome: "failed", durationMs: 1,
        code: "detached_proof_incomplete", nativeProof: value }).success).toBe(false);
    });

  it("does not trust arbitrary exceptions or attach native proof to another failure", () => {
    const value = { nativeProof: { predicate: "pty_exit" } };
    expect(diagnosticEvidence(Object.assign(new Error("private"), value))).toEqual({});
    expect(diagnosticEvidence(Object.assign(new ZerosDevError("runtime_changed"), value))).toEqual({});
  });

  it.each([
    { phase: "detached_native_proof", outcome: "ok", code: "detached_proof_incomplete" },
    { phase: "cleanup", outcome: "failed", code: "detached_proof_incomplete" },
    { phase: "detached_native_proof", outcome: "failed", code: "runtime_changed" },
  ])("refuses a diagnostic outside a failed native proof phase", fields => {
    expect(EvidenceEventSchema.safeParse({ ...fields, durationMs: 0, nativeProof: { predicate: "pty_exit" } }).success).toBe(false);
  });

  it("does not add fields or reorder legacy signed evidence", () => {
    const event = { phase: "detached_native_proof", outcome: "failed", durationMs: 1324, code: "detached_proof_incomplete" };
    expect(JSON.stringify(EvidenceEventSchema.parse(event))).toBe(JSON.stringify(event));
  });
});
