import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpServerSchema } from "../../settings/schema";
import { mcpResourceHeaders } from "./resource-headers";
import { CatalogClient } from "./list-tools";
import { safeAuthFetch } from "./safe-fetch";
import { mcpCredentialKey } from "./credential-key";
import type { OAuthVault } from "./oauth-provider";
import type { McpGatewaySecretChanges } from "../../settings/mcp-configuration";

export interface McpProbeResult {
  status: "connected" | "needs-auth" | "failed";
  stages: { stage: "validation" | "transport" | "initialize" | "tools"; status: "passed" | "failed" | "needs-auth" }[];
  toolCount?: number;
  /** Complete discovered names, before any configured tool restrictions. */
  tools?: string[];
}

/** A draft probe never launches commands, opens a browser, registers a client,
 * or mutates credentials. Abort closes both the request and the SDK stream. */
export async function probeMcpServer(raw: unknown, changes: McpGatewaySecretChanges, vault: OAuthVault, repoRoot?: string, signal?: AbortSignal): Promise<McpProbeResult> {
  const parsed = mcpServerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.transport === "stdio") return { status: "failed", stages: [{ stage: "validation", status: "failed" }] };
  const config = parsed.data;
  const stages: McpProbeResult["stages"] = [{ stage: "validation", status: "passed" }];
  const key = mcpCredentialKey(config.credential_id, config.url, repoRoot);
  let headers: Headers;
  try { headers = new Headers(mcpResourceHeaders(config, vault.readEntry(key), changes)); }
  catch { return { status: "failed", stages: [{ stage: "validation", status: "failed" }] }; }
  if (config.auth === "oauth") {
    const token = vault.getTokens(key)?.access_token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12_000);
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const client = new CatalogClient({ name: "Zeros connection check", version: "1.0.0" });
  let reached = false;
  const endpoint = new URL(config.url);
  const transportOptions = {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      // Resource credentials never accompany an OAuth/discovery or foreign URL.
      const requestHeaders = new Headers(init?.headers);
      if (url.origin === endpoint.origin) headers.forEach((value, name) => requestHeaders.set(name, value));
      const response = await safeAuthFetch(url, { ...init, headers: requestHeaders, signal: combined }, {
        allowLoopback: ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), sensitiveHeaders: [...headers.keys()],
      });
      reached = true;
      return response;
    },
  };
  const transport = config.transport === "sse" ? new SSEClientTransport(endpoint, transportOptions) : new StreamableHTTPClientTransport(endpoint, transportOptions);
  const close = () => { void transport.close().catch(() => {}); };
  combined.addEventListener("abort", close, { once: true });
  try {
    await client.connect(transport, { signal: combined, timeout: 12_000 });
    stages.push({ stage: "transport", status: "passed" }, { stage: "initialize", status: "passed" });
    const result = client.getServerCapabilities()?.tools ? await client.listTools(undefined, { signal: combined }) : { tools: [] };
    stages.push({ stage: "tools", status: "passed" });
    return { status: "connected", stages, toolCount: result.tools.length, tools: result.tools.map(tool => tool.name) };
  } catch (error) {
    const status = error instanceof UnauthorizedError || ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401) ? "needs-auth" : "failed";
    if (!stages.some(row => row.stage === "transport")) stages.push({ stage: "transport", status: reached ? "passed" : "failed" });
    stages.push({ stage: stages.some(row => row.stage === "initialize") ? "tools" : "initialize", status });
    return { status, stages };
  } finally {
    // close() ends local streams; stateful HTTP servers also need DELETE.
    // Keep the probe deadline active if the remote holds that cleanup request.
    if (!combined.aborted && transport instanceof StreamableHTTPClientTransport)
      await transport.terminateSession().catch(() => {});
    clearTimeout(timeout); combined.removeEventListener("abort", close);
    abort.abort();
    await client.close().catch(() => {}); await transport.close().catch(() => {});
  }
}
