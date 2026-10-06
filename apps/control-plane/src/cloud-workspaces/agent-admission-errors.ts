// Closed pre-provider refusals only. Mirrored with the independently deployed protocol.
export const CLOUD_AGENT_ADMISSION_CODES = [
  "cloud_runtime_upgrade_required",
  "cloud_agent_model_not_authorized",
  "cloud_agent_credential_required",
  "cloud_agent_credential_expired",
  "cloud_agent_credential_revoked",
  "cloud_agent_credential_refresh_required",
] as const;
export type CloudAgentAdmissionCode = typeof CLOUD_AGENT_ADMISSION_CODES[number];
export function isCloudAgentAdmissionCode(code: unknown): code is CloudAgentAdmissionCode {
  return typeof code === "string" && (CLOUD_AGENT_ADMISSION_CODES as readonly string[]).includes(code);
}
