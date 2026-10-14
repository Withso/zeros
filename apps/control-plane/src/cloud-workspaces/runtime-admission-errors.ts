import { HttpError } from "../authz.js";
import { DatabaseAcquireTimeoutError } from "../db.js";
import { CloudProviderError } from "./provider.js";
import { publicCloudError } from "./public-contract.js";

export type CloudRuntimeAdmissionPhase = "provider_endpoint" | "provider_host_key" | "grant" | "engine_reach";
type GrantCleanup = "not_required" | "confirmed" | "unconfirmed";
type Status = HttpError["status"] | 500;

/** Preserve the first failed boundary across cleanup, without forwarding its
 * exception, provider text or grant to a public response or a logger. */
export class CloudRuntimeAdmissionError extends Error {
  constructor(
    readonly phase: CloudRuntimeAdmissionPhase,
    cause: unknown,
    readonly grantCleanup: Exclude<GrantCleanup, "not_required">,
  ) {
    super("Cloud runtime admission failed", { cause });
    this.name = "CloudRuntimeAdmissionError";
  }
}

const transientProviderCodes = new Set([
  "provider_request_failed", "provider_request_timeout", "provider_request_unavailable", "provider_rate_limited",
]);

function transientProviderFailure(error: unknown, phase: CloudRuntimeAdmissionPhase): error is CloudProviderError {
  return (phase === "provider_endpoint" || phase === "provider_host_key") &&
    error instanceof CloudProviderError && error.retryable && transientProviderCodes.has(error.code) &&
    (error.httpStatus === undefined || error.httpStatus === 408 || error.httpStatus === 409 ||
      error.httpStatus === 429 || error.httpStatus >= 500);
}

/** Retry-After is an integer number of seconds, never a raw provider header. */
function retryAfterSeconds(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(300, Math.max(1, Math.ceil(value / 1000))) : 1;
}

export function cloudRuntimeAdmissionResponse(failure: unknown) {
  const phase: CloudRuntimeAdmissionPhase = failure instanceof CloudRuntimeAdmissionError ? failure.phase : "grant";
  const grantCleanup: GrantCleanup = failure instanceof CloudRuntimeAdmissionError ? failure.grantCleanup : "not_required";
  const error: unknown = failure instanceof CloudRuntimeAdmissionError ? failure.cause : failure;
  let status: Status = 500;
  let body = { code: "internal", message: "Internal error", phase, retryable: false };
  let retryAfter: number | undefined;
  let diagnosticCode: "internal" | "admission_refused" | "cloud_runtime_temporarily_unavailable" | "service_busy" = "internal";

  // An unpublished grant whose retirement could not be confirmed is never a
  // retry signal. Keep the first phase, but do not hide uncertain cleanup.
  if (grantCleanup !== "unconfirmed") {
    if (transientProviderFailure(error, phase)) {
      status = 503;
      body = { ...publicCloudError("cloud_runtime_temporarily_unavailable"), phase, retryable: true };
      diagnosticCode = "cloud_runtime_temporarily_unavailable";
      retryAfter = retryAfterSeconds(error.retryAfterMs);
    } else if (error instanceof DatabaseAcquireTimeoutError) {
      status = 503;
      body = { code: "service_busy", message: "Service is temporarily busy", phase, retryable: true };
      diagnosticCode = "service_busy";
      retryAfter = 1;
    } else if (error instanceof HttpError) {
      status = error.status;
      body = { ...publicCloudError(error.code), phase, retryable: false };
      diagnosticCode = "admission_refused";
    }
  }

  const sqlState = status === 500 && error !== null && typeof error === "object" &&
    "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
  return {
    status,
    error: body,
    retryAfterSeconds: retryAfter,
    diagnostic: { code: diagnosticCode, status, phase, retryable: body.retryable, grantCleanup, ...(sqlState ? { sqlState } : {}) },
  };
}
