import { describe, expect, it } from "vitest";
import { selectMeasurementOptions } from "../cloud-workspace-validation/cloud-agent-e2e/operator-options";
import { FIXTURE_REQUEST_ROUTES } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/request-observations";

describe("explicit current-path operator selection", () => {
  it("preserves the unmeasured normal matrix by default", () => {
    expect(selectMeasurementOptions([], "invalid")).toEqual({ measurement: "none", requestDelay: [], requestDelayMs: 0 });
  });
  it("selects current measurement only explicitly, with every delayed route declared", () => {
    const value = selectMeasurementOptions(["--providers", "codex", "--measurement", "current", "--cp-request-delay-ms", "100"], "invalid");
    expect(value.measurement).toBe("current"); expect(value.requestDelayMs).toBe(100);
    expect(value.requestDelay).toEqual(FIXTURE_REQUEST_ROUTES.map(route => ({ route, delayMs: 100 })));
  });
  it("never implies provider response authorization from selecting measurement", () => {
    expect(() => selectMeasurementOptions(["--measurement", "current"], "environment")).toThrow("operator_input_invalid");
  });
  it("requires explicit invalid-auth boot-owner measurement and retains all arrival counters", () => {
    expect(selectMeasurementOptions(["--measurement", "boot-owner", "--cp-request-delay-ms", "100"], "invalid"))
      .toEqual({ measurement: "boot-owner", requestDelayMs: 100,
        requestDelay: FIXTURE_REQUEST_ROUTES.map(route => ({ route, delayMs: 100 })) });
    expect(() => selectMeasurementOptions(["--measurement", "boot-owner"], "environment")).toThrow("operator_input_invalid");
  });
  it.each(["", "new", "legacy", "CURRENT", "--providers"])("refuses unsupported measurement %s", measurement => {
    expect(() => selectMeasurementOptions(["--measurement", measurement], "invalid")).toThrow("operator_input_invalid");
  });
  it.each(["", "-1", "1.5", "5001", "NaN", "Infinity", "100ms", "--providers"])("refuses invalid delay %s", delay => {
    expect(() => selectMeasurementOptions(["--measurement", "current", "--cp-request-delay-ms", delay], "invalid"))
      .toThrow("operator_input_invalid");
  });
  it("refuses ambiguous duplicate flags or a delay without the measured path", () => {
    for (const args of [["--measurement", "none", "--measurement", "current"],
      ["--measurement", "current", "--cp-request-delay-ms", "1", "--cp-request-delay-ms", "2"], ["--cp-request-delay-ms", "0"]])
      expect(() => selectMeasurementOptions(args, "invalid")).toThrow("operator_input_invalid");
  });
});
