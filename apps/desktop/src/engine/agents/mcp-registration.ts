import type { McpServerRegistration } from "./types";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Materialize an HTTP MCP registration for SDKs that do not support
 * environment-backed headers themselves. The secret stays out of the durable
 * registration and provider argv; it exists only in the already-authorized
 * session environment and the SDK request configuration. */
export function materializeMcpServerRegistration(
  registration: McpServerRegistration,
  env: Readonly<Record<string, string | undefined>>,
): McpServerRegistration {
  if (
    registration.transport !== "http" ||
    !registration.headersFromEnv ||
    Object.keys(registration.headersFromEnv).length === 0
  ) {
    return registration;
  }

  const headers = { ...(registration.headers ?? {}) };
  const occupied = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  for (const [header, envName] of Object.entries(
    registration.headersFromEnv,
  )) {
    if (!HEADER_NAME.test(header) || !ENV_NAME.test(envName)) {
      throw new Error("An MCP server has an invalid credential reference.");
    }
    if (occupied.has(header.toLowerCase())) {
      throw new Error("An MCP server defines the same HTTP header twice.");
    }
    const value = env[envName];
    if (!value) {
      throw new Error("An MCP server is missing its required session credential.");
    }
    headers[header] = value;
    occupied.add(header.toLowerCase());
  }

  return {
    name: registration.name,
    transport: "http",
    url: registration.url,
    headers,
  };
}

export function materializeMcpServerRegistrations(
  registrations: readonly McpServerRegistration[],
  env: Readonly<Record<string, string | undefined>>,
): McpServerRegistration[] {
  return registrations.map((registration) =>
    materializeMcpServerRegistration(registration, env),
  );
}
