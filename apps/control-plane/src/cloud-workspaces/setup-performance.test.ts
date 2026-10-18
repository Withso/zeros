import { describe, expect, it } from "vitest";
import { mergeSetupPerformance, parseSetupPerformance, reportSetupPerformance, setupPerformance } from "./setup-performance.js";

describe("closed setup performance", () => {
  const report = () => ({ version: 1, truncated: false, groups: [{ source: "readiness", stages: [
    { stage: "sleep", count: 1, totalMs: 20, maxMs: 20, lastOutcome: "passed" },
  ] }] });

  it("aggregates and saturates repeated waits in constant space", () => {
    let now = 0;
    const recorder = setupPerformance("readiness", () => now);
    for (let i = 0; i < 5000; i++) {
      const finish = recorder.start("sleep"); now += 1000; finish(); finish("failed");
    }
    expect(recorder.snapshot()).toEqual({ version: 1, truncated: true, groups: [{ source: "readiness", stages: [
      { stage: "sleep", count: 4096, totalMs: 3_600_000, maxMs: 1000, lastOutcome: "passed" },
    ] }] });
    expect(parseSetupPerformance(recorder.snapshot())).toEqual(recorder.snapshot());
  });

  it.each([
    (value: ReturnType<typeof report>) => ({ ...value, privateText: "synthetic private value" }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], source: "private source" }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: [{ ...value.groups[0]!.stages[0], stage: "private stage" }] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [value.groups[0], value.groups[0]] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: [...value.groups[0]!.stages, ...value.groups[0]!.stages] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ source: "readiness", stages: [{ ...value.groups[0]!.stages[0], stage: "key_install" }] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: [{ ...value.groups[0]!.stages[0], totalMs: -1 }] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: [{ ...value.groups[0]!.stages[0], count: 4097 }] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: [{ ...value.groups[0]!.stages[0], maxMs: 21 }] }] }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: new Array(7).fill(value.groups[0]) }),
    (value: ReturnType<typeof report>) => ({ ...value, groups: [{ ...value.groups[0], stages: new Array(65).fill(value.groups[0]!.stages[0]) }] }),
  ])("omits malformed, unbounded or free-text observations (%#)", mutate => {
    expect(parseSetupPerformance(mutate(report()))).toBeUndefined();
  });

  it("does not let a diagnostic getter or observer become an execution failure", () => {
    expect(parseSetupPerformance({ get groups() { throw new Error("private getter"); } })).toBeUndefined();
    const recorder = setupPerformance("transport", () => { throw new Error("private clock"); });
    recorder.start("total")();
    expect(recorder.snapshot()).toEqual({ version: 1, truncated: true, groups: [] });
    expect(() => reportSetupPerformance(() => { throw new Error("private observer"); }, recorder)).not.toThrow();
  });

  it("copies bounded snapshots and keeps different phase groups distinct", () => {
    const first = report(), second = setupPerformance("transport", () => 0);
    second.count("status_request");
    const merged = mergeSetupPerformance(first, second.snapshot(), { privateText: "private" });
    expect(merged?.groups.map(group => group.source)).toEqual(["readiness", "transport"]);
    first.groups[0]!.stages[0]!.totalMs = 999;
    expect(merged?.groups[0]?.stages[0]?.totalMs).toBe(20);
    const snapshot = second.snapshot();
    snapshot.groups[0]!.stages[0]!.count = 999;
    expect(second.snapshot().groups[0]!.stages[0]!.count).toBe(1);
  });
});
