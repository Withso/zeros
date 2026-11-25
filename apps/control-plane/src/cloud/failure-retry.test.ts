import { describe, expect, it } from "vitest";
import { CLOUD_V2_RECOVERABLE_FAILURES, cloudV2RecoverableFailure } from "./failure-retry.js";

// 2026-11-25: Alpha wakes ended worker_boot_timeout with their VM and backup intact, and the app offered only Delete.
const woke = { state: "failed", error_code: "worker_boot_timeout", active_at: new Date("2026-11-24T16:13:31Z"), boat_sandbox_id: "bx_abc12345",
  checkpoint_object: null, machine_gone_at: null, machine_data_expired_at: null } as const;
const backup = "checkpoints/w.tar";

describe("a failed cloud workspace that recovery may start again", () => {
  it("is one that failed for a passing reason while it still holds its machine or a backup", () => {
    expect(cloudV2RecoverableFailure(woke)).toBe(true);
    expect(cloudV2RecoverableFailure({ ...woke, boat_sandbox_id: null, checkpoint_object: backup })).toBe(true);
    for (const code of ["worker_boot_timeout", "worker_runtime_install_failed", "provider_request_failed", "provider_request_timeout",
      "provider_request_unavailable", "provider_rate_limited", "provider_response_invalid", "provider_route_invalid", "provider_loss_unconfirmed",
      "live_connection_unavailable"]) expect(cloudV2RecoverableFailure({ ...woke, error_code: code })).toBe(true);
    expect([...CLOUD_V2_RECOVERABLE_FAILURES].sort()).toEqual(["checkpoint_restore_failed", "live_connection_unavailable", "provider_loss_unconfirmed",
      "provider_rate_limited", "provider_request_failed", "provider_request_timeout", "provider_request_unavailable", "provider_response_invalid",
      "provider_route_invalid", "worker_boot_timeout", "worker_runtime_install_failed"]);
  });

  it("restarts a failed restore only while its checkpoint remains", () => {
    expect(cloudV2RecoverableFailure({ ...woke, error_code: "checkpoint_restore_failed", checkpoint_object: backup })).toBe(true);
    expect(cloudV2RecoverableFailure({ ...woke, error_code: "checkpoint_restore_failed" })).toBe(false);
  });

  it("is never a create that did not finish: its machine may lack the checkout and setup", () => {
    expect(cloudV2RecoverableFailure({ ...woke, active_at: null })).toBe(false);
    expect(cloudV2RecoverableFailure({ ...woke, active_at: null, checkpoint_object: backup })).toBe(false);
  });

  it("is never one with nothing left to start, or failed for a reason trying again cannot change", () => {
    expect(cloudV2RecoverableFailure({ ...woke, boat_sandbox_id: null })).toBe(false);
    expect(cloudV2RecoverableFailure({ ...woke, machine_gone_at: new Date() })).toBe(false);
    expect(cloudV2RecoverableFailure({ ...woke, machine_data_expired_at: new Date() })).toBe(false);
    expect(cloudV2RecoverableFailure({ ...woke, machine_gone_at: new Date(), checkpoint_object: backup })).toBe(true);
    for (const code of ["sandbox_missing", "github_access_required", "cloud_source_checkout_failed", "cloud_computer_build_required",
      "provider_budget_exhausted", "provider_credential_rejected", "checkpoint_corrupt", "execution_first_boot_failed", null])
      expect(cloudV2RecoverableFailure({ ...woke, error_code: code })).toBe(false);
    for (const state of ["stopped", "running", "starting", "stopping", "deleting"]) expect(cloudV2RecoverableFailure({ ...woke, state })).toBe(false);
  });
});
