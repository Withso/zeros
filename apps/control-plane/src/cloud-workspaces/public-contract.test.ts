import { describe, expect, it } from "vitest";
import { isCustomerCloudPath, publicCloudError } from "./public-contract.js";

describe("customer cloud response boundary", () => {
  it.each([
    "boat_credit_limit",
    "daytona_unavailable",
    "provider_budget_exhausted",
    "snapshot_missing",
    "https://boat.dev/private?token=hidden",
  ])("projects infrastructure error %s", (code) => {
    expect(publicCloudError(code)).toEqual({
      code: "cloud_workspace_unavailable",
      message: "The cloud workspace is temporarily unavailable",
    });
  });
  it("keeps actionable allowance and sharing errors independent of infrastructure", () => {
    expect(publicCloudError("compute_credit_exhausted").code).toBe(
      "cloud_compute_allowance_exhausted",
    );
    expect(publicCloudError("compute_allowance_legacy_conflict").code).toBe(
      "cloud_compute_allowance_unavailable",
    );
    expect(publicCloudError("cloud_workspace_writer_limit").message).toContain(
      "10 writers",
    );
  });
  it("covers customer routes without changing internal runtime or model provider contracts", () => {
    for (const path of [
      "/v1/cloud-workspaces",
      "/v1/cloud-workspaces/workspace/collaborators",
      "/v1/cloud-compute-usage",
      "/v1/cloud-workspace-invitations/accept",
      "/v1/organizations/org/cloud-workspace-management/provider-connections",
    ])
      expect(isCustomerCloudPath(path)).toBe(true);
    expect(
      isCustomerCloudPath("/internal/v1/cloud-workspaces/engine/events"),
    ).toBe(false);
    expect(isCustomerCloudPath("/v1/cloud-agent-credentials")).toBe(false);
  });
});
