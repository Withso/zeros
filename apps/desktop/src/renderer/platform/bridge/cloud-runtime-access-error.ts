// Pure, shared with Electron main. Native exceptions lose custom properties
// across invoke(); return only this closed code/status envelope, never prose.
export type CloudRuntimeAccessCategory = "transient" | "retired" | "revoked" | "superseded" | "update-required";
export const CLOUD_RUNTIME_ACCESS_ERRORS: Readonly<Record<string, { category: CloudRuntimeAccessCategory; message: string }>> = {
  cloud_actor_runtime_unavailable: { category: "transient", message: "The cloud runtime is temporarily unavailable." },
  cloud_workspace_access_unavailable: { category: "transient", message: "The cloud workspace is not ready for a connection." },
  engine_client_admission_ineligible: { category: "transient", message: "The cloud engine is not ready for a connection." },
  cloud_access_provider_unavailable: { category: "transient", message: "Cloud access is temporarily unavailable." },
  rate_limited: { category: "transient", message: "Cloud access is busy. Try again shortly." },
  request_failed: { category: "transient", message: "Cloud access is temporarily unavailable." },
  cloud_workspace_access_superseded: { category: "superseded", message: "The cloud runtime connection was replaced." },
  cloud_workspace_v2_required: { category: "retired", message: "This cloud runtime has been retired." },
  not_found: { category: "retired", message: "This cloud workspace is no longer available." },
  cloud_access_not_active: { category: "retired", message: "This cloud access has ended." },
  cloud_workspace_client_update_required: { category: "update-required", message: "Update Zeros to connect to cloud workspaces." },
  cloud_workspace_runtime_connection_required: { category: "update-required", message: "Reconnect using the current cloud runtime." },
  signed_out: { category: "revoked", message: "Sign in again to connect to this cloud workspace." },
  forbidden: { category: "revoked", message: "Cloud workspace access is not permitted." },
  cloud_actor_admission_rejected: { category: "revoked", message: "Cloud workspace access could not be authorized." },
  cloud_workspace_access_revoked: { category: "revoked", message: "Cloud workspace access has been revoked." },
  device_proof_required: { category: "revoked", message: "A trusted device is required for cloud workspace access." },
  invalid_input: { category: "retired", message: "The cloud access request is invalid." },
  bad_response: { category: "retired", message: "The cloud access response is invalid." },
};
export type CloudRuntimeAccessErrorEnvelope = { type: "cloud_runtime_access_error"; status: number; code: string };
export function cloudRuntimeAccessErrorEnvelope(error: unknown): CloudRuntimeAccessErrorEnvelope {
  const value = error && typeof error === "object" ? error as { status?: unknown; code?: unknown } : {};
  const code = typeof value.code === "string" && Object.hasOwn(CLOUD_RUNTIME_ACCESS_ERRORS, value.code) ? value.code : "request_failed";
  const status = Number.isInteger(value.status) && Number(value.status) >= 0 && Number(value.status) <= 599 ? Number(value.status) : 0;
  return { type: "cloud_runtime_access_error", status, code };
}
export class CloudRuntimeAccessError extends Error {
  readonly code: string;
  readonly status: number;
  readonly category: CloudRuntimeAccessCategory;
  constructor(error: unknown) {
    const { code, status } = cloudRuntimeAccessErrorEnvelope(error), known = CLOUD_RUNTIME_ACCESS_ERRORS[code];
    super(known.message); this.name = "CloudRuntimeAccessError"; this.code = code; this.status = status;
    this.category = code === "request_failed" && status >= 400 && status < 500 && status !== 408 && status !== 429 ? "revoked" : known.category;
  }
}
export function unwrapCloudRuntimeAccess<T>(value: unknown): T {
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "cloud_runtime_access_error") throw new CloudRuntimeAccessError(value);
  return value as T;
}
