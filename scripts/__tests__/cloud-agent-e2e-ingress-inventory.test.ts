import { describe, expect, it } from "vitest";
import { FIXTURE_REQUEST_ROUTES, FIXTURE_REQUEST_OPERATIONS } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/request-observations";

describe("shared closed fixture measurement inventory", () => {
  it("exports the immutable actual ingress routes for consumer validation", () => {
    expect(Array.isArray(FIXTURE_REQUEST_ROUTES)).toBe(true);
    expect(Object.isFrozen(FIXTURE_REQUEST_ROUTES)).toBe(true);
    expect(FIXTURE_REQUEST_ROUTES).toContain("rendererPrepare");
    expect(FIXTURE_REQUEST_ROUTES).toContain("unknown");
  });
  it("exports immutable actual operations including unclassified requests", () => {
    expect(Array.isArray(FIXTURE_REQUEST_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(FIXTURE_REQUEST_OPERATIONS)).toBe(true);
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("renderer.prepare");
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("unknown");
  });
  it("counts the actual credential-control background poll as a closed route", () => {
    expect(FIXTURE_REQUEST_ROUTES).toContain("credentialControls");
  });
  it("retains the credential-control exchange operation independently of authority or success", () => {
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("credentials.controls");
  });
});
