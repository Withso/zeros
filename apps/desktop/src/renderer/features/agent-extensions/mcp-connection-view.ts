import type { McpProbeResult } from "./mcp-server-editor";
import { secureDraftFromServer, transportOf, type RawServer } from "./mcp-server-model";

export interface McpConnectionView {
  label: string;
  hint: string;
  tone: "neutral" | "success" | "warning" | "error";
  action?: "connect" | "check";
}

/** Configuration, authorization and a successful MCP check are distinct facts.
 * Every surface uses the same next step; a 401 with API headers is not OAuth. */
export function mcpConnectionView(server: RawServer, result?: McpProbeResult, status?: string): McpConnectionView {
  if (server.enabled === false) return { label: "Disabled", hint: "Enable this server in the list to use it with your agents.", tone: "neutral" };
  if (transportOf(server) === "stdio") return { label: "Starts with agent", hint: "This server starts when an agent uses it in the selected project.", tone: "neutral" };
  if (result?.status === "connected" || (!result && status === "connected")) return {
    label: "Connected", tone: "success", action: "check",
    hint: result?.toolCount !== undefined ? `${result.toolCount} ${result.toolCount === 1 ? "tool" : "tools"} available.` : "The last connection succeeded.",
  };
  // Legacy definitions can omit auth while supplying API-key headers. Use the
  // editor's inference, but keep an explicit draft method (including none).
  const auth = server.auth ?? secureDraftFromServer(server).auth;
  if (result?.status === "needs-auth" || (!result && status === "needs-auth")) return auth === "header"
    ? { label: "Check API key", hint: "The server rejected the credentials. Check your API key headers and try again.", tone: "error", action: "check" }
    : { label: "Sign-in required", hint: "Connect your account to use this server. You can also choose API key in Authentication.", tone: "warning", action: "connect" };
  if (result?.status === "failed" || (!result && status === "error")) {
    const stage = result?.stages.find(row => row.status === "failed")?.stage;
    return { label: "Connection failed", tone: "error", action: "check", hint:
      stage === "validation" ? "Check the server details and credentials, then try again."
        : stage === "tools" ? "The server connected, but its tools could not be loaded. Try again."
          : stage === "initialize" ? "The server did not accept the MCP connection. Check its URL and try again."
            : "Could not reach the server. Check its URL and your connection, then try again.",
    };
  }
  return { label: "Needs connection", tone: "neutral", action: server.auth === "oauth" ? "connect" : "check",
    hint: server.auth === "oauth" ? "Connect your account to use this server." : "Connect to check this server and load its tools.",
  };
}
