import { describe, expect, it } from "vitest";
import { classifyCloudRestoreEvidence } from "./automatic-recovery.js";
describe("allowlisted restore evidence", () => {
  it("classifies absent immutable files and OS inventory drift", () => {
    expect(classifyCloudRestoreEvidence("setup_provider_bootstrap_unavailable", { version: 1, phase: "bootstrap",
      files: { node: false, supervisor: true, setup: true, engine: false } })).toBe("setup_immutable_runtime_missing");
    expect(classifyCloudRestoreEvidence("setup_image_contract_invalid", { version: 1, phase: "image_preflight", checks: { packageInventory: false } }))
      .toBe("setup_immutable_inventory_invalid");
  });
  it("rejects generic errors, post-hook failures, and untrusted diagnostics", () => {
    expect(classifyCloudRestoreEvidence("setup_provider_bootstrap_unavailable", undefined)).toBeNull();
    expect(classifyCloudRestoreEvidence("setup_image_contract_invalid", { version: 1, phase: "image_launch", checks: { packageInventory: false } })).toBeNull();
    expect(classifyCloudRestoreEvidence("setup_image_contract_invalid", { version: 1, phase: "image_preflight", checks: { qualified: false } })).toBeNull();
    expect(classifyCloudRestoreEvidence("setup_image_contract_invalid", { version: 1, phase: "image_preflight", checks: { source: false }, output: "secret" })).toBeNull();
    expect(classifyCloudRestoreEvidence("setup_repository_unavailable", { version: 1, phase: "image_preflight", checks: { source: false } })).toBeNull();
  });
});
