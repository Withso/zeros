import { CloudAgentConnectionHealthSchema, type CloudAgentConnectionHealth } from "./agent-connection-health-contract.js";
import { CODEX_AUTH_RUNTIME_VERSION } from "./codex-auth-cache.js";

/** Read from one scoped SQL snapshot. No material bytes or provider I/O. */
export interface CloudAgentConnectionHealthRow {
  provider: string;
  credential_id: string | null;
  credential_revision: string | null;
  consent_fingerprint: string;
  live_credential_revision: string | null;
  credential_kind: string | null;
  material_version: number | null;
  material_expires_at: Date | null;
  refresh_revision: string | null;
  refresh_material_version: number | null;
  refresh_runtime_version: string | null;
  refresh_state: "ready" | "reserved" | "dispatched" | "uncertain" | null;
  refresh_attempt_started_at: Date | null;
  observed_at: Date;
}

export function cloudAgentConnectionHealth(row: CloudAgentConnectionHealthRow, consentFingerprint: string): CloudAgentConnectionHealth {
  const selected = row.credential_id !== null;
  const present = selected && row.live_credential_revision !== null && row.material_version !== null &&
    row.credential_kind?.startsWith(`${row.provider}-`) === true;
  const remaining = present && row.material_expires_at !== null
    ? row.material_expires_at.getTime() - row.observed_at.getTime() : null;
  // Preserve Cursor's released one-minute floor; other cold boot material
  // uses the existing thirty-second admission floor.
  const floor = row.credential_kind === "cursor-api-key" ? 60_000 : 30_000;
  const status: CloudAgentConnectionHealth["status"] = !selected ? "not_selected"
    : row.consent_fingerprint !== consentFingerprint ? "consent_required"
    : !present ? "credential_unavailable"
    : row.live_credential_revision !== row.credential_revision ? "credential_changed"
    : remaining !== null && remaining <= 0 ? "expired"
    : remaining !== null && remaining <= floor ? "expiring" : "ready";
  let refresh: CloudAgentConnectionHealth["refresh"] = "not_applicable";
  if (selected && row.credential_kind === "codex-chatgpt") {
    const matches = present && row.live_credential_revision === row.credential_revision &&
      row.refresh_revision === row.live_credential_revision && row.refresh_material_version === row.material_version &&
      row.refresh_runtime_version === CODEX_AUTH_RUNTIME_VERSION;
    const elapsed = row.refresh_attempt_started_at === null ? Infinity : row.observed_at.getTime() - row.refresh_attempt_started_at.getTime();
    refresh = !matches || !["ready", "expiring", "expired"].includes(status) ? "unavailable"
      : row.refresh_state === "uncertain" || row.refresh_state === "dispatched" && elapsed >= 15_000 ? "reconnect_required"
      : ["reserved", "dispatched"].includes(row.refresh_state ?? "") && elapsed >= 0 && elapsed < 15_000 ? "in_progress"
      : status === "expired" || status === "expiring" ? "reconnect_required"
      : row.refresh_state === "ready" || row.refresh_state === "reserved" && elapsed >= 15_000 ? "idle" : "unavailable";
  }
  return CloudAgentConnectionHealthSchema.parse({version:1,status,observedAt:row.observed_at.toISOString(),
    selectedCredentialRevision:selected && row.credential_revision !== null?Number(row.credential_revision):null,
    credentialRevision:present?Number(row.live_credential_revision):null,
    materialVersion:present?row.material_version:null,expiresAt:present?row.material_expires_at?.toISOString()??null:null,refresh});
}
