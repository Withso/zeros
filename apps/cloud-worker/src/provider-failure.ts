import { cloudFailureMessage, CloudProviderFailureSchema, type CloudProviderFailure, type CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import type { BridgeAgentFailure } from "@zeros/protocol/messages";
import { normalizeProviderError } from "./drivers/shared/provider-error";
import { WorkspaceError, type WorkerConfig } from "./workspace/scope";

const reasonForKind: Record<string, CloudProviderFailure["reason"]> = {
  "auth-required": "auth-required", "verification-required": "verification-required",
  "cloud-credentials-unavailable": "credentials-unavailable", "rate-limited": "rate-limited",
  "session-expired": "session-expired", "model-unavailable": "model-unavailable", "transport-closed": "provider-unavailable",
};
const kindForReason: Record<CloudProviderFailure["reason"], BridgeAgentFailure["kind"]> = {
  "auth-required": "auth-required", "verification-required": "verification-required",
  "credentials-unavailable": "cloud-credentials-unavailable", "rate-limited": "rate-limited",
  "session-expired": "session-expired", "model-unavailable": "protocol-error", "provider-unavailable": "transport-closed",
  // Creator pays: no Creator is an account condition (no new chat fixes it); the cloud reason carries the specific copy.
  "creator-required": "auth-required",
};
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;

function retryAt(value: unknown, now = Date.now()): number | undefined {
  const seen = new Set<unknown>();
  const read = (input: unknown, depth: number): number | undefined => {
    if (depth > 5 || seen.has(input)) return;
    seen.add(input);
    const record = object(input);
    if (!record) return;
    const headers = record.headers;
    const raw = headers instanceof Headers ? headers.get("retry-after")
      : object(headers)?.["retry-after"] ?? object(headers)?.["Retry-After"];
    if (typeof raw === "string" && raw.length <= 128) {
      const deadline = /^\d+$/.test(raw.trim()) ? now + Number(raw) * 1000 : Date.parse(raw);
      if (Number.isSafeInteger(deadline) && deadline >= now) return deadline;
    }
    return read(record.error, depth + 1) ?? read(record.data, depth + 1) ?? read(record.cause, depth + 1);
  };
  return read(value, 0);
}

export function providerFailure(provider: CloudV2Agent, error: unknown, stage?: BridgeAgentFailure["stage"], confirmedKind?: string): BridgeAgentFailure {
  // A retired worker route is an adoption miss, not evidence that the native
  // provider lost its conversation. The desktop must still be able to re-adopt.
  if (error instanceof WorkspaceError) return { kind: error.code === "session-expired" ? "session-expired"
    : error.code === "auth-required" ? "auth-required" : "protocol-error",
    agentId: provider, ...(stage ? { stage } : {}), message: error.message };
  const native = normalizeProviderError(provider, error);
  const carried = CloudProviderFailureSchema.safeParse(object(error)?.cloud);
  const category = confirmedKind ?? (typeof object(error)?.code === "string" && reasonForKind[String(object(error)!.code)] ? String(object(error)!.code) : native.category);
  const reason = reasonForKind[category];
  const deadline = reason === "rate-limited" ? retryAt(error) : undefined;
  const cloud = carried.success && carried.data.provider === provider ? carried.data : reason ? {
    source: "provider" as const, provider, reason,
    ...(deadline !== undefined ? { retryAt: deadline } : {}),
  } : undefined;
  return { kind: cloud ? kindForReason[cloud.reason] : "protocol-error", agentId: provider, ...(stage ? { stage } : {}),
    message: cloud ? cloudFailureMessage(cloud) : "The agent could not complete this request.", ...(cloud ? { cloud } : {}) };
}

/** One verdict for advertised readiness and every new native admission. */
export function providerAvailability(provider: CloudV2Agent, config: WorkerConfig, installed: boolean): CloudProviderFailure | undefined {
  // Creator pays: an activated workspace's agents run on the current Creator's logins, which the config names (no secret).
  if (installed && config.actingUser === 1 && config.agentLogins)
    return config.agentLogins[provider] ? undefined : { source: "provider", provider, reason: "auth-required" };
  const login = config.agents[provider];
  const reason = !installed ? "provider-unavailable" : !login ? "auth-required"
    : "expiresAt" in login && login.expiresAt <= Date.now() ? "credentials-unavailable" : undefined;
  return reason ? { source: "provider", provider, reason } : undefined;
}

export function retainProviderFailure(provider: CloudV2Agent, error: unknown, message: string): Error {
  const failure = providerFailure(provider, error);
  return Object.assign(new Error(message), { code: failure.cloud?.source === "provider" && failure.cloud.reason === "model-unavailable" ? "model-unavailable" : failure.kind,
    ...(failure.cloud ? { cloud: failure.cloud } : {}) });
}
