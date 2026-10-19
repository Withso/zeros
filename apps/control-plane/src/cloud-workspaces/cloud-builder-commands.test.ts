import { describe, expect, it } from "vitest";
import { builderFixedCommand, parseBuilderDiagnostic, RUNTIME_SMOKE_CHECKS } from "./cloud-builder-commands.js";

describe("runtime smoke vocabulary", () => {
  it("uses a fixed isolated bytecode-free build qualification entry and closed integrity diagnostics", () => {
    expect(builderFixedCommand("computer:qualify-build", null)).toBe("/usr/bin/sudo -n /usr/bin/python3 -I -B /opt/zeros-bootstrap/computer-build.py qualify-build");
    const value = { schema: "zeros.diagnostic/v1", component: "build", stage: "integrity", ok: true,
      exitCode: 0, timedOut: false, failedChecks: [] };
    expect(parseBuilderDiagnostic(JSON.stringify(value), "computer:qualify-build", 0)).toEqual(value);
    expect(parseBuilderDiagnostic(JSON.stringify({ ...value, stage: "sanitation" }), "computer:qualify-build", 0)).toBeNull();
    expect(builderFixedCommand("computer:qualify-arbitrary", null)).toBeNull();
  });
  it("requires the owned engine lifecycle check in new inventory", () => {
    expect(RUNTIME_SMOKE_CHECKS).toContain("engine_lifecycle");
    expect(RUNTIME_SMOKE_CHECKS).not.toContain("containment_smoke");
  });
  it.each(["engine_lifecycle", "containment_smoke"])("reads current or archived %s diagnostics", check => {
    const value = { schema: "zeros.diagnostic/v1", component: "qualification", ok: false, stage: "self_test",
      exitCode: 1, timedOut: false, failedChecks: [check] };
    expect(parseBuilderDiagnostic(JSON.stringify(value), "runtime-self-test", 1)).toEqual(value);
    expect(parseBuilderDiagnostic(JSON.stringify({ ...value, failedChecks: ["arbitrary_text"] }), "runtime-self-test", 1)).toBeNull();
  });
});
