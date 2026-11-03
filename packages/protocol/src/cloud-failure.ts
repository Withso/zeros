import { z } from "zod";

export const CloudProviderFailureSchema = z.object({
  source: z.literal("provider"),
  provider: z.enum(["claude", "codex", "cursor"]),
  reason: z.enum(["auth-required", "verification-required", "credentials-unavailable", "rate-limited", "session-expired", "model-unavailable", "provider-unavailable"]),
  retryAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const CloudMcpFailureSchema = z.object({
  source: z.literal("mcp"),
  serverId: z.uuid(),
  reason: z.enum(["sign-in-required", "sign-in-refused", "server-error", "unreachable"]),
}).strict();
export const CloudFailureSchema = z.discriminatedUnion("source", [CloudProviderFailureSchema, CloudMcpFailureSchema]);
export type CloudProviderFailure = z.infer<typeof CloudProviderFailureSchema>;
export type CloudMcpFailure = z.infer<typeof CloudMcpFailureSchema>;
export type CloudFailure = z.infer<typeof CloudFailureSchema>;

/** Public copy is derived from bounded evidence, never from upstream prose. */
export function cloudFailureMessage(failure: CloudFailure): string {
  switch (failure.reason) {
    case "auth-required": return "The provider rejected its credentials. Reconnect the provider account, then try again.";
    case "verification-required": return "The provider requires account verification. Check the provider account before trying again.";
    case "credentials-unavailable": return "The cloud provider connection is unavailable. Zeros is waiting for renewed credentials.";
    case "rate-limited": return "The provider's usage or rate limit was reached. Try again later.";
    case "session-expired": return "The provider session is no longer available. Start a new session to continue.";
    case "model-unavailable": return "This model is unavailable for the provider account. Choose another model.";
    case "provider-unavailable": return "The provider could not be reached or is temporarily unavailable. Try again later.";
    case "sign-in-required": return "This MCP server requires sign-in. Connect the server to continue.";
    case "sign-in-refused": return "Access to this MCP server was refused. Check the server connection and account permissions.";
    case "server-error": return "The MCP server could not complete the request. Retry the server connection.";
    case "unreachable": return "The MCP server connection is unavailable. Retry when it is reachable.";
  }
}
