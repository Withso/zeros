import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HttpError } from "../authz.js";
import { materializeMcp } from "./model.js";
import { safeMcpFetch, withMcpSignal } from "./safe-fetch.js";
import type { McpStore } from "./store.js";
import type { McpOAuth } from "./oauth.js";

export interface ProbeResult {
  status: "connected" | "needs-auth" | "failed";
  stages: Array<{ stage: "validation" | "transport" | "initialize" | "tools"; status: "passed" | "failed" | "needs-auth" }>;
  toolCount?: number;
  message?: string;
}
/** Only the native runtime may execute an unsaved command. The control plane
 * validates and verifies remote MCP with real protocol requests, then closes. */
export async function probeMcp(store: McpStore, oauth: McpOAuth, org: string, user: string, raw: unknown,
  signal?: AbortSignal, fetchImpl: FetchLike = safeMcpFetch): Promise<ProbeResult> {
  const stages: ProbeResult["stages"] = [];
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000); timeout.unref();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  let reached = false, initialized = false, unauthorized = false;
  const client = new McpClient({ name: "zeros-connection-check", version: "1.0.0" });
  let transport: SSEClientTransport | StreamableHTTPClientTransport | undefined;
  try {
    const draft = await withMcpSignal(store.draft(org, user, raw), controller.signal), config = materializeMcp(draft.config, draft.secrets);
    if (config.transport === "stdio") throw new HttpError(422, "mcp_runtime_required", "Verify this command in the workspace where it will run");
    stages.push({ stage: "validation", status: "passed" });
    let headers = config.headers ?? {};
    if (config.auth === "oauth") {
      if (draft.input.oauthAttemptId) headers = { ...headers, ...(await withMcpSignal(oauth.draftAuthorization(org, user, draft.input.oauthAttemptId, draft.binding), controller.signal)).headers };
      else if (draft.input.extensionId) {
        const current = await withMcpSignal(store.get(org, user, draft.input.extensionId), controller.signal);
        if (current.oauth_binding !== draft.binding) throw new HttpError(409, "mcp_auth_required", "Sign in to this MCP server");
        headers = { ...headers, ...(await withMcpSignal(oauth.authorization(org, user, current.id), controller.signal)).headers };
      } else throw new HttpError(409, "mcp_auth_required", "Sign in to this MCP server");
    }
    const fetchFn: FetchLike = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).origin !== new URL(config.url).origin) throw new Error("MCP probe endpoint changed origin");
      const response = await withMcpSignal(Promise.resolve(fetchImpl(input, { ...init, signal: controller.signal })), controller.signal);
      if (!reached) { reached = true; stages.push({ stage: "transport", status: "passed" }); }
      if (response.status === 401 || response.status === 403) unauthorized = true;
      return response;
    };
    const options = { requestInit: { headers }, fetch: fetchFn };
    transport = config.transport === "sse" ? new SSEClientTransport(new URL(config.url), options) : new StreamableHTTPClientTransport(new URL(config.url), options);
    // SDK 1.32 declares optional sessionId differently on its own Transport and
    // StreamableHTTPClientTransport under exactOptionalPropertyTypes.
    await client.connect(transport as Transport, { signal: controller.signal, timeout: 20_000 });
    initialized = true; stages.push({ stage: "initialize", status: "passed" });
    let toolCount = 0;
    if (client.getServerCapabilities()?.tools) {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal: controller.signal, timeout: 20_000 });
        toolCount += result.tools.length;
        if (toolCount > 1024) throw new Error("MCP tools limit exceeded");
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 9) throw new Error("MCP tools page limit exceeded");
      }
    }
    stages.push({ stage: "tools", status: "passed" });
    await withMcpSignal(store.requireMember(org, user), controller.signal);
    return { status: "connected", stages, toolCount };
  } catch (error) {
    if (error instanceof HttpError && ([401,403,404].includes(error.status) || !stages.length)) throw error;
    const needsAuth = unauthorized || (error instanceof HttpError && error.code === "mcp_auth_required");
    const status = needsAuth ? "needs-auth" : "failed";
    // An absent OAuth grant is known before any socket exists. Do not report
    // a transport stage that was never attempted.
    if (reached || !needsAuth) stages.push({ stage: !stages.length ? "validation" : !reached ? "transport" : !initialized ? "initialize" : "tools", status });
    return { status, stages, message: needsAuth ? "Sign in or check the configured API headers" : controller.signal.aborted ? "Connection check timed out or was cancelled" : "The server did not complete the MCP connection check" };
  } finally {
    if (!controller.signal.aborted && transport instanceof StreamableHTTPClientTransport)
      await withMcpSignal(transport.terminateSession(), controller.signal).catch(() => {});
    clearTimeout(timeout); signal?.removeEventListener("abort", abort); controller.abort();
    await client.close().catch(() => {});
  }
}
