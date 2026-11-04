import { CloudMcpFailureSchema, cloudFailureMessage, type CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";

export function mcpFailure(serverId: string, error: unknown): CloudMcpFailure {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const known = CloudMcpFailureSchema.safeParse(value.cloud);
  if (known.success && known.data.serverId === serverId) return known.data;
  const status = value.status ?? value.statusCode;
  const reason = value.code === "mcp_auth_required" || status === 401 ? "sign-in-required"
    : status === 403 ? "sign-in-refused"
    : typeof status === "number" || typeof value.code === "number" ? "server-error" : "unreachable";
  return { source: "mcp", serverId, reason };
}

export function mcpFailureError(cloud: CloudMcpFailure): Error & { cloud: CloudMcpFailure } {
  return Object.assign(new Error(cloudFailureMessage(cloud)), { cloud });
}
