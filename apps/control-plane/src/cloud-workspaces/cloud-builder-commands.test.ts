import { describe, expect, it } from "vitest";
import { parseBuilderDiagnostic, RUNTIME_SMOKE_CHECKS } from "./cloud-builder-commands.js";

describe("runtime smoke vocabulary", () => {
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
