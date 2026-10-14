import { describe, expect, it } from "vitest";
import { HttpError } from "../authz.js";
import { DatabaseAcquireTimeoutError } from "../db.js";
import { CloudProviderError } from "./provider.js";
import { CloudRuntimeAdmissionError, cloudRuntimeAdmissionResponse } from "./runtime-admission-errors.js";

const endpointFailure = (cause: unknown) => new CloudRuntimeAdmissionError("provider_endpoint", cause, "confirmed");

describe("closed runtime admission failures", () => {
  it.each([
    [undefined, 1], [0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [0.1, 1], [1001, 2], [900_000, 300],
  ])("bounds a typed provider retry header from %s milliseconds to %s seconds", (retryAfterMs, seconds) => {
    const response = cloudRuntimeAdmissionResponse(endpointFailure(new CloudProviderError(
      "provider_request_failed", "private upstream text", true, { httpStatus: 503, retryAfterMs },
    )));
    expect(response.status).toBe(503);
    expect(response.retryAfterSeconds).toBe(seconds);
    expect(response.error).toMatchObject({ code: "cloud_runtime_temporarily_unavailable", phase: "provider_endpoint", retryable: true });
    expect(JSON.stringify(response)).not.toContain("private upstream text");
  });

  it.each([
    ["provider_request_timeout", undefined], ["provider_request_unavailable", undefined],
    ["provider_rate_limited", 429], ["provider_request_failed", 408], ["provider_request_failed", 409],
  ] as const)("recognizes the typed transient %s at the provider boundary", (code, httpStatus) => {
    expect(cloudRuntimeAdmissionResponse(endpointFailure(new CloudProviderError(code, "private", true, { httpStatus }))))
      .toMatchObject({ status: 503, retryAfterSeconds: 1, error: { retryable: true } });
  });

  it.each([
    ["provider_credential_rejected", true, 401], ["provider_budget_exhausted", true, 402],
    ["provider_access_response_invalid", true, undefined], ["provider_request_failed", false, 503],
    ["provider_request_failed", true, 403], ["unrecognized_provider_failure", true, 503],
  ] as const)("never retries a refusal or unknown provider category %s/%s/%s", (code, retryable, httpStatus) => {
    expect(cloudRuntimeAdmissionResponse(endpointFailure(new CloudProviderError(code, "private", retryable, { httpStatus }))))
      .toMatchObject({ status: 500, retryAfterSeconds: undefined, error: { code: "internal", retryable: false } });
  });

  it("does not infer a provider failure from an exception thrown in the grant phase", () => {
    const error = new CloudRuntimeAdmissionError("grant", new CloudProviderError("provider_request_failed", "private", true, { httpStatus: 503 }), "confirmed");
    expect(cloudRuntimeAdmissionResponse(error)).toMatchObject({ status: 500, error: { phase: "grant", retryable: false } });
  });

  it("retains only a SQLSTATE from a grant defect and never logs its text or bound values", () => {
    const error = Object.assign(new Error("private query"), { code: "23505", detail: "private value", query: "private SQL" });
    const response = cloudRuntimeAdmissionResponse(new CloudRuntimeAdmissionError("grant", error, "confirmed"));
    expect(response.diagnostic).toEqual({ code: "internal", status: 500, phase: "grant", retryable: false, grantCleanup: "confirmed", sqlState: "23505" });
    expect(response.error).toEqual({ code: "internal", message: "Internal error", phase: "grant", retryable: false });
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it("retains deliberate refusal status and projects neither its text nor details", () => {
    const response = cloudRuntimeAdmissionResponse(new HttpError(403, "cloud_workspace_capability_required", "private refusal", { identity: "private identity" }));
    expect(response).toMatchObject({ status: 403, error: { code: "cloud_workspace_capability_required", phase: "grant", retryable: false },
      diagnostic: { code: "admission_refused", grantCleanup: "not_required" } });
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it("preserves the existing pool-busy response without labelling it a provider outage", () => {
    expect(cloudRuntimeAdmissionResponse(new DatabaseAcquireTimeoutError())).toMatchObject({ status: 503, retryAfterSeconds: 1,
      error: { code: "service_busy", phase: "grant", retryable: true }, diagnostic: { code: "service_busy", grantCleanup: "not_required" } });
  });
});
