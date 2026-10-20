import { decodeCloudCommandFailure } from "@zeros/protocol/cloud-commands";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";

const sites = [
  "heartbeat-preflight", "heartbeat-request", "heartbeat-response", "heartbeat-credential", "heartbeat-checkpoint",
  "heartbeat-work", "heartbeat-timer", "event-journal", "human-services", "language-services", "legacy-agent",
  "goal-observation", "checkpoint-quiescence", "agent-boot", "runner-retirement", "native-pump", "history-publication",
  "command-prepare", "command-finish", "command-settlement", "conversation-delete", "conversation-cancel", "idle-retirement",
  "terminal-retirement", "terminal-track", "terminal-launch", "language-release", "engine-shutdown",
] as const;
export type CloudRuntimeRetirementSite = typeof sites[number];
export type CloudRuntimeRetirementDiagnostic = { site: CloudRuntimeRetirementSite; code: string };
const codes = new Set([
  "authority_http_401", "authority_http_403", "authority_http_4xx", "authority_response_invalid", "engine_lease_expired",
  "heartbeat_task_failed", "engine_authority_rejected", "event_conflict", "event_stream_changed", "event_response_invalid",
  "event_sequence_exhausted", "event_storage_unavailable", "event_buffer_exhausted", "event_service_unavailable",
  "command_conflict", "command_context_changed", "command_storage_unavailable", "cloud_command_writer_retired",
  "cloud_actor_authority_rejected", "credential_control_authority_rejected", "credential_control_conflict",
  "credential_control_storage_unavailable", "credential_control_invalid", "credential_control_limit", "unclassified_failure",
]);

/** Only closed identifiers reach diagnostics. Never copy message, stack, HTTP
 * body, provider output, or arbitrary properties from the original failure. */
export function cloudRuntimeRetirementDiagnostic(site: CloudRuntimeRetirementSite, error?: unknown): CloudRuntimeRetirementDiagnostic {
  let code: unknown;
  try { code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? error.code : undefined; }
  catch { /* Diagnostic access cannot interfere with retirement. */ }
  return { site, code: typeof code === "string" && (codes.has(code) || decodeCloudCommandFailure(code) || isCloudAgentAdmissionCode(code))
    ? code : "unclassified_failure" };
}

export function logCloudRuntimeRetirement(kind: "authority" | "shutdown", site: CloudRuntimeRetirementSite, error?: unknown): void {
  try {
    console.error(kind === "authority" ? "[Zeros cloud] durable engine authority was retired" : "[Zeros cloud] engine shutdown failed",
      cloudRuntimeRetirementDiagnostic(site, error));
  } catch { /* Logging never changes cleanup, authority, or the exit deadline. */ }
}
