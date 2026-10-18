import { describe, expect, it } from "vitest";
import { CloudProviderError } from "./provider.js";
import { DatabaseAcquireTimeoutError, DatabaseConnectionLostError } from "../db.js";
import { classifyCloudFailure, cloudDiagnosticSchema, parseSetupDiagnostic, setupDiagnosticSchema, cloudStopReason, publicCloudIncident } from "./cloud-diagnostics.js";
import { CLOUD_ENGINE_STARTUP_PHASES, CLOUD_ENGINE_STARTUP_NAMES, CLOUD_ENGINE_STARTUP_CODES, CLOUD_ENGINE_STARTUP_ERRNOS,
  parseCloudEngineStartupFailure } from "../../../desktop/src/engine/agents/containment/cloud-engine-startup-failure.mjs";
describe("bounded cloud diagnostics", () => {
  it.each([
    new DatabaseConnectionLostError(), new DatabaseAcquireTimeoutError(),
    Object.assign(new Error("private-database-detail"), { code: "40001" }),
    Object.assign(new Error("private-database-detail"), { code: "40P01" }),
    ...["57014", "55P03", "57P01", "08006", "database_acquire_unavailable"].map(code => Object.assign(new Error("private-database-detail"), { code })),
  ])("OF19 classifies known database unavailability without raw exception material", error => {
    const diagnostic = classifyCloudFailure(error, "ledger_commit");
    expect(diagnostic).toMatchObject({ code: "control_plane_unavailable", errorClass: "database", retryable: true });
    expect(JSON.stringify(diagnostic)).not.toContain("private-database-detail");
  });
  it("OF19 retains only closed compute throw sites", () => {
    const diagnostic = { phase: "ledger_commit", code: "compute_reconciliation_failed", errorClass: "unknown", retryable: true };
    for (const site of ["allocation_binding", "allocation_observation", "meter_commit", "renewal_plan", "renewal_reservation", "renewal_commit", "reconciliation_bookkeeping", "retry_proof"])
      expect(cloudDiagnosticSchema.safeParse({ ...diagnostic, site }).success).toBe(true);
    expect(cloudDiagnosticSchema.safeParse({ ...diagnostic, site: "private-path-or-message" }).success).toBe(false);
  });
  it("OF19 distinguishes the CP outage stop from a permanent safety failure without a wire migration", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(publicCloudIncident({ id, reason: "safety_failure", stopReason: "control_plane_unavailable" })).toMatchObject({
      code: "cloud_workspace_control_plane_unavailable",
    });
    expect(cloudStopReason("control_plane_unavailable").code).toBe("control_plane_unavailable");
    expect(classifyCloudFailure(Object.assign(new Error("private-corruption-detail"), { code: "23514" }), "ledger_commit"))
      .toMatchObject({ code: "compute_reconciliation_failed", errorClass: "database", sqlState: "23514" });
  });
  it.each(["setup_worker_stopped", "setup_heartbeat_failed", "setup_lease_lost", "setup_timed_out",
    "setup_unknown_failure", "setup_executor_failure"])("keeps the closed worker failure code %s", code => {
    expect(classifyCloudFailure({ code }, "runtime").code).toBe(code);
  });
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
  it("retains only closed nonempty attester refusal checks", () => {
    const attester = { stage: "qualify_engine", failedChecks: ["seccomp"] };
    const diagnostic = { version: 1, phase: "image_preflight", attester };
    expect(parseSetupDiagnostic(diagnostic)).toEqual(diagnostic);
    for (const invalid of [{ ...attester, stage: "private-canary" }, { ...attester, failedChecks: ["private-canary"] },
      { ...attester, failedChecks: [] }, { ...attester, failedChecks: ["seccomp", "seccomp"] },
      { ...attester, output: "private-canary" }, { ...attester, failedChecks: Array(33).fill("seccomp") }])
      expect(parseSetupDiagnostic({ ...diagnostic, attester: invalid })).toBeNull();
  });

  it("retains a closed engine startup cause in an additive setup readiness diagnostic", () => {
    const valid = { version: 1, phase: "engine_readiness", engineStartup: {
      phase: "history_restore", name: "Error", code: "ENOENT", errno: -2,
    } };
    expect(parseSetupDiagnostic(valid)).toEqual(valid);
    for (const field of ["message", "stack", "path", "body", "cause", "engineInstanceId"])
      expect(parseSetupDiagnostic({ ...valid, engineStartup: { ...valid.engineStartup, [field]: "credential-canary" } })).toBeNull();
    for (const patch of [{ phase: "credential-canary" }, { name: "credential-canary" }, { code: "credential-canary" },
      { errno: "credential-canary" }, { errno: 123456789 }, { errno: -2.5 }])
      expect(parseSetupDiagnostic({ ...valid, engineStartup: { ...valid.engineStartup, ...patch } })).toBeNull();
  });
  it("accepts exactly the producer's closed startup vocabulary", () => {
    const schema = setupDiagnosticSchema.shape.engineStartup.unwrap().shape;
    expect(schema.phase.options).toEqual(CLOUD_ENGINE_STARTUP_PHASES);
    expect(schema.name.options).toEqual(CLOUD_ENGINE_STARTUP_NAMES);
    expect(schema.code.options).toEqual(CLOUD_ENGINE_STARTUP_CODES);
    const failure = { phase: "startup", name: "unknown", code: "unknown", errno: null };
    for (const [key, values] of [["phase", CLOUD_ENGINE_STARTUP_PHASES], ["name", CLOUD_ENGINE_STARTUP_NAMES],
      ["code", CLOUD_ENGINE_STARTUP_CODES], ["errno", CLOUD_ENGINE_STARTUP_ERRNOS]] as const)
      for (const value of values) {
        const engineStartup = { ...failure, [key]: value };
        expect(parseCloudEngineStartupFailure(engineStartup)).toEqual(engineStartup);
        const diagnostic = { version: 1, phase: "engine_readiness", engineStartup };
        expect(parseSetupDiagnostic(diagnostic)).toEqual(diagnostic);
      }
  });
  it("keeps boot substages and typed denial/transport causes readable without retaining provider text", () => {
    for (const phase of ["boot_owner", "boot_bootstrap", "boot_credentials", "boot_durability", "boot_activate", "boot_install"])
      for (const code of ["cloud_admission_authority_timeout", "cloud_validation_authority_http_5xx", "cloud_validation_access_denied",
        "cloud_agent_credential_revoked", "command_storage_unavailable"]) {
        const diagnostic = { version: 1, phase: "engine_readiness", engineStartup: { phase, name: "CloudAgentExecutionError", code, errno: null } };
        expect(parseSetupDiagnostic(diagnostic)).toEqual(diagnostic);
        expect(parseSetupDiagnostic({ ...diagnostic, engineStartup: { ...diagnostic.engineStartup, body: "private-canary" } })).toBeNull();
      }
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
