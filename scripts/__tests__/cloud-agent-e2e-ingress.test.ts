import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizeFixtureIngress, summarizeFixtureWindow } from "../cloud-workspace-validation/cloud-agent-e2e/ingress";
import { FIXTURE_REQUEST_ROUTES, FIXTURE_REQUEST_OPERATIONS } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/request-observations";
import { diagnoseHarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";

const fixtureInstanceId = randomUUID(), clockDomainId = randomUUID(), clientClockId = randomUUID();
const calibration = { clockDomainId, clientClockId, clientBeforeAtMs: 120, fixtureSampleAtUs: 20_000, clientAfterAtMs: 122 };
const interval = { clientClockId, throughStage: "native_write" as const, fromAtMs: { min: 120, max: 122 }, throughAtMs: { min: 150, max: 152 } };

describe("exact fixture Send/result window", () => {
  it("validates the complete arrival window independently of a calibrated native boundary", () => {
    expect(summarizeFixtureWindow(window())).toMatchObject({ ingressCount: 4, completionCount: 3, pendingAtStart: 1, pendingAtEnd: 2 });
  });
  it("retains incomplete and contradictory counter refusals for the full Send window", () => {
    expect(() => summarizeFixtureWindow({ ...window(), detailsComplete: false })).toThrow("ingress_details_incomplete");
    expect(() => summarizeFixtureWindow({ ...window(), ingressCount: 5 })).toThrow("fixture_measurement_invalid");
  });
});
function window() {
  return { version: 1, fixtureInstanceId, clockDomainId, clockSource: "node-process-hrtime", startAtUs: 1000, endAtUs: 100_000,
    ingressCount: 4, completionCount: 3, routeCounts: { rendererPrepare: 1, commands: 2, actor: 1 } as Record<string, number>,
    completionRouteCounts: { rendererPrepare: 1, commands: 2 } as Record<string, number>,
    operationArrivalCounts: { "renderer.prepare": 1, "commands.mutate": 1, "commands.read": 1, "client.renew": 1 } as Record<string, number>,
    completionOperationCounts: { "renderer.prepare": 1, "commands.mutate": 1, "commands.read": 1 } as Record<string, number>,
    inFlightAtStart: 1, inFlightAtEnd: 2, activeHandlers: 2, detailsComplete: true, countersComplete: true,
    causalCoverage: "unavailable", foregroundIngressCount: null, backgroundIngressCount: null,
    unknownCausalIngressCount: 4, unknownCausalPendingAtStart: 1,
    requests: [
      { route: "heartbeat", method: "POST", operation: "engine.heartbeat", arrivalSequence: 1, arrivedAtUs: 500,
        completionSequence: null, completedAtUs: null, status: null, beganBeforeWindow: true },
      { route: "rendererPrepare", method: "POST", operation: "renderer.prepare", arrivalSequence: 2, arrivedAtUs: 5000,
        completionSequence: 1, completedAtUs: 40_000, status: 200, beganBeforeWindow: false },
      { route: "commands", method: "POST", operation: "commands.mutate", arrivalSequence: 3, arrivedAtUs: 25_000,
        completionSequence: 2, completedAtUs: 30_000, status: 200, beganBeforeWindow: false },
      { route: "commands", method: "POST", operation: "commands.read", arrivalSequence: 4, arrivedAtUs: 50_000,
        completionSequence: 3, completedAtUs: 60_000, status: 403, beganBeforeWindow: false },
      { route: "actor", method: "POST", operation: "client.renew", arrivalSequence: 5, arrivedAtUs: 55_000,
        completionSequence: null, completedAtUs: null, status: null, beganBeforeWindow: false },
    ] };
}
describe("fixture ingress clock/window evidence", () => {
  it("uses the owner's exported immutable closed route/operation inventories", () => {
    expect(FIXTURE_REQUEST_ROUTES).toContain("rendererPrepare");
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("renderer.prepare");
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("unknown");
    expect(Object.isFrozen(FIXTURE_REQUEST_ROUTES)).toBe(true);
    expect(Object.isFrozen(FIXTURE_REQUEST_OPERATIONS)).toBe(true);
  });
  it("counts boundary uncertainty and pre-window pending work without route-based causal claims", () => {
    const result = summarizeFixtureIngress(window(), calibration, interval);
    expect(result.fullWindow.ingressCount).toBe(4);
    expect(result.fullWindow.completionCount).toBe(3);
    expect(result.interval.arrivalCount).toEqual({ min: 1, max: 2 });
    expect(result.interval.pendingAtStartCount).toEqual({ min: 2, max: 2 });
    expect(result.causalCoverage).toBe("unavailable");
    expect(result.foregroundIngressCount).toBeNull(); expect(result.backgroundIngressCount).toBeNull();
    expect(result.fullWindow.pendingAtStart).toBe(1);
  });
  it("retains bounded closed request rows with actual timestamps and calibrated interval membership", () => {
    const result = summarizeFixtureIngress(window(), calibration, interval);
    expect(result.requests).toHaveLength(5);
    expect(result.requests[1]).toEqual({
      route: "rendererPrepare", method: "POST", operation: "renderer.prepare", arrivalSequence: 2,
      completionSequence: 1, arrivedAtUs: 5000, completedAtUs: 40_000, status: 200, beganBeforeWindow: false,
      arrivedAtClientMs: { min: 104.999, max: 107.001 }, completedAtClientMs: { min: 139.999, max: 142.001 },
      arrivalInInterval: "outside", pendingAtIntervalStart: "certain", origin: "unverified", spanId: null, waitId: null,
    });
    expect(result.requests[2].arrivalInInterval).toBe("certain");
    expect(result.requests[3].arrivalInInterval).toBe("possible");
    expect(result.requests[4].arrivalInInterval).toBe("outside");
    expect(result.requests.filter(row => row.arrivalInInterval === "certain")).toHaveLength(result.interval.arrivalCount.min);
    expect(result.requests.filter(row => row.arrivalInInterval !== "outside")).toHaveLength(result.interval.arrivalCount.max);
  });
  it("does not infer request origin or await identity from routes and returns independent row snapshots", () => {
    const value = window(), result = summarizeFixtureIngress(value, calibration, interval);
    expect(result.requests.every(row => row.origin === "unverified" && row.spanId === null && row.waitId === null)).toBe(true);
    value.requests[2].status = 401; value.requests[2].arrivedAtUs = 26_000;
    expect(result.requests[2]).toMatchObject({ status: 200, arrivedAtUs: 25_000 });
    expect(result.causalCoverage).toBe("unavailable");
    expect(result.foregroundIngressCount).toBeNull();
  });
  it("reports exact counts when clocks and boundaries are exact", () => {
    const result = summarizeFixtureIngress(window(), { ...calibration, clientAfterAtMs: 120 },
      { ...interval, fromAtMs: { min: 120, max: 120 }, throughAtMs: { min: 150.01, max: 150.01 } });
    expect(result.interval.arrivalCount).toEqual({ min: 2, max: 2 });
  });
  it("preserves integer-microsecond stamp uncertainty at a native boundary", () => {
    const result = summarizeFixtureIngress(window(), { ...calibration, clientAfterAtMs: 120 },
      { ...interval, fromAtMs: { min: 120, max: 120 }, throughAtMs: { min: 150, max: 150 } });
    expect(result.interval.arrivalCount).toEqual({ min: 1, max: 2 });
    expect(result.fixtureTimestampResolutionUs).toBe(1);
  });
  it("counts denied and unknown arrivals instead of dropping them", () => {
    const value = window(); value.requests[2].route = "unknown"; value.requests[2].operation = "unknown"; value.requests[2].status = 401;
    value.routeCounts = { rendererPrepare: 1, commands: 1, actor: 1, unknown: 1 };
    value.completionRouteCounts = { rendererPrepare: 1, commands: 1, unknown: 1 };
    value.operationArrivalCounts = { "renderer.prepare": 1, "commands.read": 1, "client.renew": 1, unknown: 1 };
    value.completionOperationCounts = { "renderer.prepare": 1, "commands.read": 1, unknown: 1 };
    expect(summarizeFixtureIngress(value, calibration, interval).interval.arrivalCount).toEqual({ min: 1, max: 2 });
  });
  it.each(["detailsComplete", "countersComplete"] as const)("refuses missing %s coverage", field => {
    const value = window(); value[field] = false;
    expect(() => summarizeFixtureIngress(value, calibration, interval)).toThrow("ingress_details_incomplete");
  });
  it("refuses a foreign fixture clock calibration", () => {
    expect(() => summarizeFixtureIngress(window(), { ...calibration, clockDomainId: randomUUID() }, interval)).toThrow("ingress_calibration_invalid");
  });
  it("refuses a foreign client clock boundary", () => {
    expect(() => summarizeFixtureIngress(window(), calibration, { ...interval, clientClockId: randomUUID() })).toThrow("ingress_calibration_invalid");
  });
  it.each([{ ...calibration, clientBeforeAtMs: 123 }, { ...calibration, clientAfterAtMs: 6000 },
    { ...calibration, fixtureSampleAtUs: Infinity }])("refuses invalid/unbounded calibration", invalid => {
    expect(() => summarizeFixtureIngress(window(), invalid, interval)).toThrow("ingress_calibration_invalid");
  });
  it("refuses an interval whose uncertainty extends outside retained window coverage", () => {
    expect(() => summarizeFixtureIngress(window(), calibration, { ...interval, fromAtMs: { min: 101, max: 105 } }))
      .toThrow("ingress_interval_outside_window");
  });
  it.each(["ingressCount", "completionCount", "inFlightAtEnd"] as const)("refuses inconsistent %s", field => {
    const value = window(); value[field]++;
    expect(() => summarizeFixtureIngress(value, calibration, interval)).toThrow("fixture_measurement_invalid");
  });
  it("refuses omitted or duplicate detail even when declared complete", () => {
    for (const requests of [window().requests.slice(1), [...window().requests.slice(1), window().requests[1]]])
      expect(() => summarizeFixtureIngress({ ...window(), requests }, calibration, interval)).toThrow("fixture_measurement_invalid");
  });
  it("refuses fabricated route/operation aggregates", () => {
    const value = window(); value.routeCounts.commands = 1; value.routeCounts.actor = 2;
    expect(() => summarizeFixtureIngress(value, calibration, interval)).toThrow("fixture_measurement_invalid");
  });
  it("refuses a fabricated historical completion", () => {
    const value = window(); value.requests[0].completedAtUs = 200_000 as unknown as null;
    expect(() => summarizeFixtureIngress(value, calibration, interval)).toThrow("fixture_measurement_invalid");
  });
  it("refuses added raw prose or unknown labels with closed diagnostics", () => {
    const value = { ...window(), material: "private-sentinel" };
    let failure: unknown; try { summarizeFixtureIngress(value, calibration, interval); } catch (error) { failure = error; }
    expect(String(failure)).toContain("fixture_measurement_invalid");
    expect(JSON.stringify(diagnoseHarnessFailure(failure))).not.toContain("private-sentinel");
  });
});
