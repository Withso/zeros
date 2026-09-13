import type { ListMcpServerStatusResponse } from "./generated/v2/ListMcpServerStatusResponse";
import type { McpServerOauthLoginResponse } from "./generated/v2/McpServerOauthLoginResponse";
import type { SessionToolsSnapshot } from "@zeros/protocol/agent-extensions";
import { normalizeExternalHttpUrl } from "@zeros/protocol/external-url";
import type { CodexAppServerHandle } from "./app-server";

/** Read the admitted thread, never the account's global configuration. App
 * tools are already grouped by Codex under the single codex_apps server. */
export async function readCodexSessionTools(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  threadId: string,
): Promise<SessionToolsSnapshot> {
  const entries = new Map<string, SessionToolsSnapshot["entries"][number]>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  const deadline = Date.now() + 8_000;
  for (let page = 0; page < 10; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Tool status timed out.");
    const result = await runtime.requestTyped<
      "mcpServerStatus/list",
      ListMcpServerStatusResponse
    >(
      "mcpServerStatus/list",
      {
        threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
      { timeoutMs: Math.min(3_000, remaining) },
    );
    for (const server of result.data) {
      // Disabled local declarations are not part of this session's Tools list.
      if (server.runtimeStatus === "disabled") continue;
      const status =
        server.runtimeStatus === "connected"
          ? "connected"
          : server.runtimeStatus === "authenticationRequired"
            ? "needs-auth"
            : server.runtimeStatus === "starting" ||
                server.runtimeStatus === "notStarted"
              ? "connecting"
              : "error";
      entries.set(server.name, {
        id: server.name,
        name: server.name,
        status,
        ...(status === "needs-auth" && server.authStatus === "notLoggedIn"
          ? { canAuthenticate: true }
          : {}),
        ...(server.runtimeStatus == null
          ? { detail: "Codex has not confirmed this connection." }
          : {}),
      });
    }
    if (!result.nextCursor)
      return { entries: [...entries.values()], state: "ready" };
    if (seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return {
    entries: [...entries.values()],
    state: "partial",
    detail: "The provider returned an incomplete tool list.",
  };
}

export async function authenticateCodexSessionTool(
  runtime: Pick<CodexAppServerHandle, "requestTyped">,
  threadId: string,
  toolId: string,
): Promise<{ authorizationUrl: string }> {
  // A renderer cannot turn this into login for an arbitrary configured server.
  const current = await readCodexSessionTools(runtime, threadId);
  if (
    !current.entries.some(
      (entry) => entry.id === toolId && entry.canAuthenticate,
    )
  )
    throw new Error("Authentication is not available for this tool.");
  const result = await runtime.requestTyped<
    "mcpServer/oauth/login",
    McpServerOauthLoginResponse
  >(
    "mcpServer/oauth/login",
    {
      threadId,
      name: toolId,
    },
    { timeoutMs: 10_000 },
  );
  const authorizationUrl = normalizeExternalHttpUrl(result.authorizationUrl);
  if (!authorizationUrl)
    throw new Error("The provider returned an invalid authentication link.");
  return { authorizationUrl };
}
