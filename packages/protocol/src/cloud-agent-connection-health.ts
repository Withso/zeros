import { z } from "zod";

// Mirrored by apps/control-plane/src/agent-credentials/agent-connection-health-contract.ts (Zod 3).
/** Selected vault metadata only; neither model admission nor a refresh grant. */
export const CloudAgentConnectionHealthSchema = z.object({
  version: z.literal(1),
  status: z.enum(["ready", "not_selected", "consent_required", "credential_unavailable", "credential_changed", "expiring", "expired"]),
  observedAt: z.string().datetime({ offset: true }),
  selectedCredentialRevision: z.number().int().positive().safe().nullable(),
  credentialRevision: z.number().int().positive().safe().nullable(),
  materialVersion: z.number().int().positive().safe().nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  refresh: z.enum(["not_applicable", "idle", "in_progress", "reconnect_required", "unavailable"]),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Connection health observation is inconsistent" });
  if (value.status === "not_selected") {
    if (value.selectedCredentialRevision !== null || value.credentialRevision !== null ||
        value.materialVersion !== null || value.expiresAt !== null || value.refresh !== "not_applicable") invalid();
    return;
  }
  if (value.selectedCredentialRevision === null) invalid();
  if ((value.credentialRevision === null) !== (value.materialVersion === null) ||
      value.credentialRevision === null && value.expiresAt !== null) invalid();
  if (value.status === "credential_unavailable" && value.credentialRevision !== null) invalid();
  if (value.status === "credential_changed" && (value.credentialRevision === null ||
      value.credentialRevision === value.selectedCredentialRevision)) invalid();
  if (["ready", "expiring", "expired"].includes(value.status) && (value.credentialRevision === null ||
      value.credentialRevision !== value.selectedCredentialRevision)) invalid();
  const remaining = value.expiresAt === null ? null : Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  if (value.status === "expired" && (remaining === null || remaining > 0) ||
      value.status === "expiring" && (remaining === null || remaining <= 0 || remaining > 60_000) ||
      value.status === "ready" && remaining !== null && remaining <= 0) invalid();
  if (["idle", "in_progress"].includes(value.refresh) && value.credentialRevision === null) invalid();
});
export type CloudAgentConnectionHealth = z.infer<typeof CloudAgentConnectionHealthSchema>;
