import { SetupObservationSchema, type SetupObservation } from "./setup-observation";

/** Only these codes may leave the CLI. Provider errors, bodies and stack traces
 * are never evidence; neither are arbitrary error.code/name/message values. */
export const ERROR_CODES = [
  "invalid_request", "fixture_invalid", "identity_changed", "login_required",
  "auth_contract", "auth_denied", "auth_unavailable", "auth_unknown_issuance", "service_unavailable",
  "rate_limited", "not_found", "forbidden", "bad_response", "deadline",
  "credentials_unsafe", "credentials_missing", "credentials_invalid", "credentials_changed", "credentials_busy",
  "receipt_invalid", "receipt_busy", "receipt_missing", "operation_conflict",
  "computer_required", "computer_failed", "repository_required", "workspace_failed", "workspace_not_running",
  "agent_credential_required", "agent_failed", "permission_required", "command_uncertain",
  "runtime_unavailable", "runtime_changed", "runtime_pin_unconfirmed", "terminal_failed", "cleanup_pending", "database_unavailable",
  "database_readonly_required", "input_contains_credentials", "cancelled", "internal",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export class ZerosDevError extends Error {
  readonly setup?: SetupObservation;
  constructor(readonly code: ErrorCode, readonly status?: number, readonly retryAfterMs?: number, setup?: SetupObservation) {
    super(`zeros_dev_${code}`);
    const parsed = SetupObservationSchema.safeParse(setup);
    if (parsed.success) this.setup = parsed.data;
  }
}
export function setupEvidence(error: unknown): { setup?: SetupObservation } {
  if (!(error instanceof ZerosDevError)) return {};
  const parsed = SetupObservationSchema.safeParse(error.setup);
  return parsed.success ? { setup: parsed.data } : {};
}
export function closedError(error: unknown): ErrorCode {
  if (error instanceof ZerosDevError) return error.code;
  // The storage module runs without TS. Recognize only its exact fixed codes.
  if (error instanceof Error && /^zeros_dev_credentials_(?:unsafe|missing|invalid|changed|busy)$/.test(error.message))
    return error.message.slice("zeros_dev_".length) as ErrorCode;
  return "internal";
}
