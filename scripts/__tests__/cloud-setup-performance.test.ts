import { describe, expect, it } from "vitest";
import {
  mergeSetupPerformance, notifySetupPerformance, parseSetupPerformance, selectSetupPerformance,
  setupPerformance, setupPerformanceStages, unwrapSetupPerformanceDiagnostic, wrapSetupPerformanceDiagnostic,
} from "../cloud-workspace-validation/sandbox/cloud-setup-performance.mjs";
import { parseSetupPerformance as parseControlPlane } from "../../apps/control-plane/src/cloud-workspaces/setup-performance";

const metric = { stage: "total", count: 1, totalMs: 10, maxMs: 10, lastOutcome: "passed" };
const value = { version: 1, truncated: false, groups: [{ source: "helper", stages: [metric] }] };
describe("closed guest setup performance", () => {
  it("fits every permitted label at its numeric ceiling in the existing reader", () => {
    const complete = { version: 1, truncated: true, groups: Object.entries(setupPerformanceStages).map(([source, stages]) => ({
      source, stages: stages.map(stage => ({ stage, count: 4096, totalMs: 3600000, maxMs: 3600000, lastOutcome: "cancelled" })),
    })) };
    expect(complete.groups.reduce((count, group) => count + group.stages.length, 0)).toBe(64);
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThanOrEqual(8192);
    expect(parseSetupPerformance(complete)).toEqual(complete);
    expect(parseControlPlane(complete)).toEqual(complete);
  });
  it("rejects unknown fields, source confusion, repeated labels and unbounded values in both readers", () => {
    const changed = (change: object) => ({ ...value, groups: [{ source: "helper", stages: [{ ...metric, ...change }] }] });
    for (const parse of [parseSetupPerformance, parseControlPlane]) {
      expect(parse(value)).toEqual(value);
      for (const invalid of [null, {}, { ...value, secret: "synthetic-private" }, { ...value, groups: Array(7).fill(value.groups[0]) },
        { ...value, groups: [{ source: "helper", stages: Array(65).fill(metric) }] },
        { ...value, groups: [value.groups[0], value.groups[0]] },
        ...[{ stage: "host_key" }, { stage: "synthetic-private" }, { count: 4097 }, { count: 0 }, { totalMs: Infinity },
          { totalMs: 3600001 }, { maxMs: 11 }, { maxMs: -1 }, { count: 1.5 }, { lastOutcome: "unknown" }, { output: "synthetic-private" }].map(changed)])
        expect(parse(invalid)).toBeUndefined();
    }
  });
  it("separates producer groups and omits malformed measurements without changing a diagnostic", () => {
    const diagnostic = { schema: "zeros.diagnostic/v1", ok: false };
    expect(selectSetupPerformance(value, ["helper"])).toEqual(value);
    expect(selectSetupPerformance(value, ["installer"])).toBeUndefined();
    expect(unwrapSetupPerformanceDiagnostic(wrapSetupPerformanceDiagnostic(diagnostic, value))).toEqual({ diagnostic, performance: value });
    expect(wrapSetupPerformanceDiagnostic(diagnostic, { secret: "synthetic-private" })).toBe(diagnostic);
    expect(unwrapSetupPerformanceDiagnostic({ schema: "zeros.diagnostic/v2", diagnostic, performance: { invalid: true } }).diagnostic).toBe(diagnostic);
    expect(mergeSetupPerformance(value, { secret: "synthetic-private" })).toEqual(value);
  });
  it("saturates repeated observations, detaches snapshots and isolates clock and observer failures", () => {
    let now = 5;
    const metrics = setupPerformance("helper", () => now);
    const finish = metrics.start("materials"); now += 3; finish("failed"); finish("passed");
    const before = metrics.snapshot();
    for (let count = 0; count < 5000; count++) metrics.record("total", 3600000);
    const after = parseControlPlane(metrics.snapshot())!;
    expect(after.truncated).toBe(true);
    expect(after.groups[0].stages).toEqual([
      { stage: "materials", count: 1, totalMs: 3, maxMs: 3, lastOutcome: "failed" },
      { stage: "total", count: 4096, totalMs: 3600000, maxMs: 3600000, lastOutcome: "passed" },
    ]);
    expect(before.groups[0].stages).toHaveLength(1);
    expect(() => notifySetupPerformance(() => { throw new Error("synthetic-private"); }, after)).not.toThrow();
    const broken = setupPerformance("helper", () => { throw new Error("synthetic-private"); });
    expect(() => broken.start("total")()).not.toThrow();
    expect(broken.snapshot()).toEqual({ version: 1, truncated: true, groups: [] });
  });
});
