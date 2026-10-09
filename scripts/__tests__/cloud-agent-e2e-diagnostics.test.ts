import { describe, expect, it } from "vitest";
import { cloudPreflightDiagnostic, zsrAdmissionDiagnostic } from "../cloud-workspace-validation/cloud-agent-e2e/diagnostics";
import { diagnoseHarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";
describe("closed ingress evidence diagnostics", () => {
  it.each(["fixture_measurement_invalid", "ingress_calibration_invalid", "ingress_interval_outside_window", "ingress_details_incomplete"])(
    "retains the exact bounded refusal %s", code => {
      expect(diagnoseHarnessFailure(Object.assign(new Error("private-sentinel"), { code }))).toEqual({ code });
    });
});
describe("closed production preflight diagnostics", () => {
  it("distinguishes missing captured suffix from fixed container validation without exposing it", () => {
    expect(zsrAdmissionDiagnostic("[zsr] admission failed for claude: host-parity canary exited 125\n"))
      .toMatchObject({ suffixPresent: false, supervisorPrefixPresent: false, containerPrefixPresent: false });
    const evidence = zsrAdmissionDiagnostic("[zsr] admission failed for claude: host-parity canary exited 125: [cloud-container-worker] container endpoint directory has unsafe ownership or permissions /private\n");
    expect(evidence).toMatchObject({ suffixPresent: true, supervisorPrefixPresent: false, containerPrefixPresent: true,
      reasons: ["canary_exit", "container_directory_rejected"] });
    expect(JSON.stringify(evidence)).not.toMatch(/private|endpoint directory/);
  });
  it("classifies fixed SRT dependencies and privileged-worker gates without copying paths", () => {
    expect(zsrAdmissionDiagnostic("[zsr] admission failed for claude: host-parity canary exited 125: [zsr-supervisor] Sandbox dependencies not available: bubblewrap (bwrap) not installed, socat not installed, apply-seccomp missing /secret\n"))
      .toMatchObject({ reasons: ["canary_exit", "sandbox_dependencies_unavailable", "dependency_bwrap", "dependency_socat", "dependency_seccomp"] });
    expect(zsrAdmissionDiagnostic("[zsr] admission failed for claude: host-parity canary exited 125: [zsr-supervisor] Privileged cloud-worker proxy composition is not qualified\n"))
      .toMatchObject({ reasons: ["canary_exit", "privileged_worker_rejected"] });
    expect(zsrAdmissionDiagnostic("[zsr] admission failed for claude: host-parity canary exited 125: [zsr-supervisor] cloud-worker ripgrep must be a canonical regular executable\n"))
      .toMatchObject({ reasons: ["canary_exit", "tool_not_canonical"] });
  });
  it("classifies exact supervisor descriptor and native-home gates without retaining prose", () => {
    expect(zsrAdmissionDiagnostic("[zsr] admission failed (activation=0ms): host-parity canary exited 125: [zsr-supervisor] command descriptor permissions are too broad: Bearer private\n"))
      .toMatchObject({ reasons: ["canary_exit", "supervisor_descriptor_rejected"], canaryExitCode: 125 });
    expect(zsrAdmissionDiagnostic("[zsr] admission failed (activation=0ms): host-parity canary exited 125: [zsr-supervisor] Cloud native home is not privately owned\n"))
      .toMatchObject({ reasons: ["canary_exit", "native_home_rejected"] });
  });
  it("retains completed native stages and fixed canary cause without the original diagnostic prose", () => {
    const logs = "[zsr] admission failed for secret-provider after 72ms (preflight=1ms ownership=1ms territory=0ms policy=3ms resources=9ms cloud-state=4ms activation=0ms pending=54ms): host-parity canary exited 1: private Podman service did not become ready: Bearer secret\n";
    expect(zsrAdmissionDiagnostic(logs)).toEqual({ completed: ["preflight", "ownership", "territory", "policy", "resources", "cloud-state", "activation"],
      reasons: ["canary_exit", "podman_service_unready"], canaryExitCode: 1,
      suffixPresent: true, supervisorPrefixPresent: false, containerPrefixPresent: false });
    expect(JSON.stringify(zsrAdmissionDiagnostic(logs))).not.toMatch(/private|secret|Bearer/);
    expect(zsrAdmissionDiagnostic("provider prose")).toBeUndefined();
  });
  it("retains the original production preflight stage/code and fixed reasons", () => {
    const value = { code: "cloud_containment_environment_setup_failed", reasons: ["podman_unavailable"] };
    expect(cloudPreflightDiagnostic(`[zsr] cloud preflight rejected ${JSON.stringify(value)}\n`)).toEqual(value);
  });
  it("never copies arbitrary keys/reasons, prose, argv or malformed oversized log records", () => {
    for (const value of [ { code: "Bearer private", reasons: ["podman_unavailable"] },
      { code: "cloud_containment_environment_setup_failed", reasons: ["secret path"] },
      { code: "cloud_containment_environment_setup_failed", reasons: ["podman_unavailable"], argv: ["Bearer private"] } ])
      expect(cloudPreflightDiagnostic(`[zsr] cloud preflight rejected ${JSON.stringify(value)}\n`)).toBeUndefined();
    expect(cloudPreflightDiagnostic(`[zsr] cloud preflight rejected ${"x".repeat(2000)}\n`)).toBeUndefined();
    expect(cloudPreflightDiagnostic("provider prose")).toBeUndefined();
  });
});
