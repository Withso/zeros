import { describe, expect, it } from "vitest";
import { parseSetupTimings, setupTimingClock, setupTimingSources, setupTimingStages } from "../cloud-workspace-validation/sandbox/cloud-setup-timings.mjs";
import { parseSetupTimings as parseControlPlane, setupTimingSources as controlSources, setupTimingStages as controlStages } from "../../apps/control-plane/src/cloud-workspaces/setup-timings";
import { setupTimingsSchema, setupTimingSources as protocolSources, setupTimingStages as protocolStages } from "../../packages/protocol/src/cloud-runtime-bundle";

const clock = { source: "setup", clockId: "11111111-1111-4111-8111-111111111111", startedAt: "2026-10-06T00:00:00.000Z",
  spans: [{ stage: "repository", startMs: 0, endMs: 100, outcome: "passed" }] };
const value = { version: 1, clocks: [clock] };
const parsers = [parseSetupTimings, parseControlPlane, (input: unknown) => setupTimingsSchema.safeParse(input).success ? input : undefined];
describe("closed setup timings", () => {
  it("keeps helper/control-plane/protocol vocabularies aligned", () => {
    expect(setupTimingSources).toEqual(controlSources); expect(protocolSources).toEqual(controlSources);
    expect(setupTimingStages).toEqual(controlStages); expect(protocolStages).toEqual(controlStages);
  });
  it("accepts bounded offsets and rejects free text, extra keys, duplicate clocks and invalid dates in every reader", () => {
    const badClock = (change: object) => ({ ...value, clocks: [{ ...clock, ...change }] });
    for (const parse of parsers) {
      expect(parse(value)).toEqual(value);
      for (const invalid of [null, {}, { ...value, version: 2 }, { ...value, secret: "private" }, { ...value, clocks: [clock, clock] },
        badClock({ clockId: "private" }), badClock({ startedAt: "private" }), badClock({ startedAt: "2026-02-30T00:00:00.000Z" }),
        badClock({ source: "private" }), badClock({ spans: Array(33).fill(clock.spans[0]) }),
        ...[{ stage: "private" }, { startMs: -1 }, { endMs: 3_600_001 }, { startMs: 101 }, { endMs: 1.2 }, { outcome: "private" }, { text: "private" }]
          .map(change => badClock({ spans: [{ ...clock.spans[0], ...change }] }))]) expect(parse(invalid)).toBeUndefined();
    }
  });
  it("keeps monotonic spans bounded and makes completion idempotent", () => {
    const timing = setupTimingClock("setup"), finish = timing.start("repository");
    finish("failed"); finish("passed");
    const result = parseControlPlane(timing.snapshot())!;
    expect(result.clocks[0].spans).toHaveLength(1);
    expect(result.clocks[0].spans[0].outcome).toBe("failed");
    expect(result.clocks[0].spans[0].endMs).toBeGreaterThanOrEqual(result.clocks[0].spans[0].startMs);
  });
});
