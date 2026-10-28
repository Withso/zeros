import type { McpServerRegistration } from "../types";

export interface McpGatewayEndpoint { url: string; authorization: string }
export const MCP_GATEWAY_CAPABILITY_ENV = "ZEROS_MCP_GATEWAY_CAPABILITY";

/** Pass only the variable reference to provider configuration, never argv. */
export function gatewayRegistration(endpoint: McpGatewayEndpoint, env: Record<string, string>): McpServerRegistration {
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(endpoint.authorization)) throw new Error("MCP gateway authorization is unavailable.");
  env[MCP_GATEWAY_CAPABILITY_ENV] = endpoint.authorization;
  return { name: "zeros-gateway", transport: "http", url: endpoint.url, headersFromEnv: { Authorization: MCP_GATEWAY_CAPABILITY_ENV } };
}
