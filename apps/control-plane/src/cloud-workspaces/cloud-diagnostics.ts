import { z } from "zod";
import { CloudProviderError } from "./provider.js";

export const diagnosticPhases = ["provider_inspect", "meter_read", "ledger_commit", "authority_check", "provider_renew", "final_settlement",
  "setup_admission", "bootstrap", "runtime", "supervisor", "image_preflight", "repository", "credential_projection", "image_launch", "engine_launch", "engine_readiness"] as const;
export type CloudDiagnosticPhase = typeof diagnosticPhases[number];
const imageChecks = z.object({ metadata: z.boolean().optional(), source: z.boolean().optional(), engine: z.boolean().optional(),
  osRelease: z.boolean().optional(), packageInventory: z.boolean().optional(), node: z.boolean().optional(),
  execution: z.boolean().optional(), report: z.boolean().optional(), profile: z.boolean().optional(), qualified: z.boolean().optional(),
  build: z.boolean().optional(), helpers: z.boolean().optional(), resources: z.boolean().optional(), runtime: z.boolean().optional(),
}).strict();
const digestPair = z.object({ expected: z.string().regex(/^[a-f0-9]{64}$/), observed: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const setupDiagnosticSchema = z.object({ version: z.literal(1), phase: z.enum(diagnosticPhases), checks: imageChecks.optional(),
  digests: z.object({ osRelease: digestPair.optional(), packageInventory: digestPair.optional(), node: digestPair.optional() }).strict().optional(),
  files: z.object({ node: z.boolean(), supervisor: z.boolean(), setup: z.boolean(), engine: z.boolean() }).strict().optional(),
  exit: z.enum(["nonzero", "timeout", "signal", "overflow", "unknown"]).optional(),
}).strict();
export type SetupDiagnostic = z.infer<typeof setupDiagnosticSchema>;
export function parseSetupDiagnostic(value: unknown): SetupDiagnostic | null {
  try { if (Buffer.byteLength(JSON.stringify(value)) > 4096) return null; } catch { return null; }
  const parsed = setupDiagnosticSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
// Only codes defined by our adapters and lifecycle are diagnostic material.
// A syntactically plausible arbitrary error.code can itself be a credential.
const codes = new Set([
  "compute_credit_funding_mode_conflict", "compute_credit_meter_rejected", "compute_credit_period_unavailable", "compute_credit_scope_not_found", "compute_credit_scope_rejected", "compute_credit_unavailable", "compute_credit_user_funding_required",
  "provider_access_cleanup_unverified", "provider_account_unverified", "provider_authorization_failed", "provider_budget_exhausted", "provider_create_outcome_unknown", "provider_credential_rejected", "provider_delete_unverified", "provider_deletion_blocked", "provider_deletion_pending", "provider_deletion_unconfirmed", "provider_generation_mismatch", "provider_generation_retired", "provider_identity_invalid", "provider_lease_invalid", "provider_lease_unconfirmed", "provider_not_found", "provider_operation_conflict", "provider_operation_pending", "provider_paused_requires_stop", "provider_profile_unsupported", "provider_request_failed", "provider_request_invalid", "provider_resource_configuration_mismatch", "provider_resource_id_invalid", "provider_resource_lost", "provider_resource_mismatch", "provider_resource_missing", "provider_response_too_large", "provider_snapshot_configuration_mismatch", "provider_snapshot_identity_mismatch", "provider_snapshot_unavailable", "provider_temporarily_unavailable", "provider_usage_invalid", "provider_vm_preflight_unavailable", "provider_vm_quota_exhausted", "provider_vm_quota_unavailable",
  "compute_credit_invalid", "compute_policy_unavailable", "compute_previous_lease_pending", "compute_credit_conflict", "compute_lease_busy", "compute_policy_changed", "compute_lease_unfunded",
  "provider_usage_unavailable", "provider_lease_unavailable", "compute_reconciliation_failed", "compute_lease_superseded", "compute_provider_unqualified", "compute_absence_unconfirmed",
  "compute_final_meter_unavailable", "compute_stop_meter_unconfirmed", "compute_lease_unconfirmed", "compute_settlement_incomplete",
  "compute_credit_exhausted", "compute_scope_unavailable", "compute_delete_settlement", "compute_allocation_retry_expired",
  "provider_identity_mismatch", "provider_request_unavailable", "provider_request_timeout", "provider_rate_limited",
  "provider_response_invalid", "provider_billing_scope_mismatch", "provider_billing_scope_unknown", "provider_bootstrap_unavailable",
  "provider_access_response_invalid", "provider_command_failed", "provider_command_timeout", "provider_command_unavailable",
  "engine_lease_expired", "engine_unavailable", "setup_image_contract_invalid", "setup_helper_failed", "setup_provider_failure",
  "setup_provider_bootstrap_unavailable", "setup_admission_unavailable", "setup_engine_readiness_failed", "setup_checkpoint_restore_invalid",
  "setup_checkpoint_restore_unavailable", "setup_repository_revision_invalid", "setup_repository_unavailable", "setup_command_failed",
  "setup_request_invalid", "setup_settings_invalid", "setup_execution_aborted", "setup_readiness_invalid", "setup_helper_response_invalid",
  "setup_helper_response_truncated", "setup_helper_secret_echo", "setup_admission_invalid", "setup_admission_revoke_failed",
]);
export function diagnosticCode(value: unknown): string { return typeof value === "string" && codes.has(value) ? value : "compute_reconciliation_failed"; }
const sqlState = /^(?:08|22|23|25|28|40|42|53|54|55|57|58|XX)[A-Z0-9]{3}$/;
export const cloudDiagnosticSchema = z.object({ phase: z.enum(diagnosticPhases), code: z.string().refine(value => codes.has(value)),
  providerCode: z.string().refine(value => codes.has(value)).optional(), sqlState: z.string().regex(sqlState).optional(),
  httpClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]).optional(),
  errorClass: z.enum(["provider", "database", "timeout", "abort", "type", "range", "unknown"]), retryable: z.boolean(),
  elapsedMs: z.number().int().min(0).max(86_400_000).optional(), fundedTtlMs: z.number().int().min(-86_400_000).max(86_400_000).optional(),
  providerTtlMs: z.number().int().min(-86_400_000).max(86_400_000).optional(), retryCount: z.number().int().min(0).max(10000).optional(),
  decision: z.enum(["checkpoint", "direct_stop", "retry", "stale", "reject_setup"]).optional(), claim: z.enum(["current", "stale"]).optional(),
  setup: setupDiagnosticSchema.optional(),
}).strict();
export type CloudDiagnostic = z.infer<typeof cloudDiagnosticSchema>;
export function classifyCloudFailure(error: unknown, phase: CloudDiagnosticPhase): CloudDiagnostic {
  const raw = error && typeof error === "object" ? error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; httpStatus?: unknown } : {};
  const state = typeof raw.code === "string" && sqlState.test(raw.code) ? raw.code : undefined;
  const code = diagnosticCode(raw.code);
  const status = raw.httpStatus ?? raw.status ?? raw.statusCode;
  return { phase, code, errorClass: state ? "database" : error instanceof CloudProviderError ? "provider" :
    raw.name === "TimeoutError" ? "timeout" : raw.name === "AbortError" ? "abort" : error instanceof TypeError ? "type" : error instanceof RangeError ? "range" : "unknown",
    retryable: error instanceof CloudProviderError ? error.retryable : true,
    ...(state ? { sqlState: state } : {}),
    ...(error instanceof CloudProviderError && codes.has(error.code) ? { providerCode: code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600 ? { httpClass: `${Math.floor(status / 100)}xx` as "1xx" | "2xx" | "3xx" | "4xx" | "5xx" } : {}),
  };
}
export function cloudStopReason(reason: string) {
  if (["budget_stop", "compute_credit_exhausted"].includes(reason)) return { code: "budget_stop", message: "Managed compute stopped at its funded limit" };
  if (["engine_expired", "engine_lease_expired", "engine_unavailable", "engine_heartbeat_expired"].includes(reason)) return { code: "engine_expired", message: "Workspace stopped because its engine lease expired" };
  if (["image_integrity_rejected", "setup_image_contract_invalid"].includes(reason)) return { code: "image_integrity_rejected", message: "Workspace image failed integrity verification" };
  return { code: "safety_failure", message: "Managed compute stopped after a safety check failed" };
}

/** Preserve the released two-key error shape and allowance code. Nothing from
 * the private cause is eligible for projection into a workspace response. */
export function publicCloudIncident(incident: { id: string; reason: string }) {
  if (!z.string().uuid().safeParse(incident.id).success ||
      !["budget_stop", "safety_failure", "engine_expired", "image_integrity_rejected"].includes(incident.reason)) return null;
  return { code: incident.reason === "budget_stop" ? "cloud_compute_allowance_exhausted" : `cloud_workspace_${incident.reason}`,
    message: `${cloudStopReason(incident.reason).message} (incident ${incident.id})` };
}
