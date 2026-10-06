import { describe, expect, it } from "vitest";
import { CloudProviderError } from "./provider.js";
import { classifyCloudFailure, parseSetupDiagnostic, cloudStopReason, publicCloudIncident } from "./cloud-diagnostics.js";
describe("bounded cloud diagnostics", () => {
  it("retains typed causes without messages, stacks, nested bodies or arbitrary codes", () => {
    const canary = "credential-canary-do-not-retain";
    const db = Object.assign(new Error(canary), { code: "40001", detail: canary });
    expect(classifyCloudFailure(db, "ledger_commit")).toMatchObject({ phase: "ledger_commit", sqlState: "40001", errorClass: "database" });
    const provider = Object.assign(new CloudProviderError("provider_request_unavailable", canary, true), { status: 503, response: { body: canary } });
    expect(classifyCloudFailure(provider, "provider_inspect")).toMatchObject({ providerCode: "provider_request_unavailable", httpClass: "5xx", retryable: true });
    expect(JSON.stringify(classifyCloudFailure(provider, "provider_inspect"))).not.toContain(canary);
    expect(classifyCloudFailure(Object.assign(new Error(canary), { code: "credential_canary" }), "meter_read").code).toBe("compute_reconciliation_failed");
  });
  it("rejects malformed, nested, unknown and oversized setup envelopes", () => {
    const valid = { version: 1, phase: "image_preflight", checks: { source: false, engine: true, packageInventory: false } };
    expect(parseSetupDiagnostic(valid)).toEqual(valid);
    for (const value of [{ ...valid, message: "secret" }, { ...valid, checks: { source: { value: true } } }, { ...valid, phase: "arbitrary" }, { ...valid, checks: { source: "x".repeat(5000) } }])
      expect(parseSetupDiagnostic(value)).toBeNull();
  });
  it("distinguishes stable stop reasons", () => {
    expect(cloudStopReason("compute_credit_exhausted").code).toBe("budget_stop");
    expect(cloudStopReason("compute_reconciliation_failed").code).toBe("safety_failure");
    expect(cloudStopReason("engine_lease_expired").code).toBe("engine_expired");
    expect(cloudStopReason("setup_image_contract_invalid").code).toBe("image_integrity_rejected");
  });
  it("projects only a closed reason and validated incident reference", () => {
    const id="11111111-1111-4111-8111-111111111111";
    expect(publicCloudIncident(Object.assign({id,reason:"budget_stop"},{message:"credential-canary"}))).toEqual({
      code:"cloud_compute_allowance_exhausted",message:`Managed compute stopped at its funded limit (incident ${id})`,
    });
    expect(publicCloudIncident({id,reason:"credential-canary"})).toBeNull();
    expect(publicCloudIncident({id:"credential-canary",reason:"safety_failure"})).toBeNull();
  });
  it("projects an outage stop without changing the stored legacy reason or incident reference", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(publicCloudIncident({ id, reason: "safety_failure", stopReason: "provider_outage" })).toEqual({
      code: "cloud_workspace_provider_outage",
      message: `Workspace stopped because a provider outage exhausted its compute lease runway (incident ${id})`,
    });
    expect(publicCloudIncident({ id, reason: "safety_failure", stopReason: "credential-canary" })?.code).toBe("cloud_workspace_safety_failure");
  });
});
