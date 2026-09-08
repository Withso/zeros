import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ExtensionEntry,
  ExtensionInventory,
} from "@zeros/protocol/agent-extensions";

/** Read a live SDK control channel. Browsing Customize must not start a Claude
 * conversation or broaden native settings just to discover account connectors. */
export async function readClaudeConnectors(
  query: Pick<Query, "mcpServerStatus"> | null,
): Promise<ExtensionInventory> {
  const result: ExtensionInventory = {
    entries: [],
    warnings: [],
    note: "Claude account connectors are reported by active sessions. The SDK has no separate account-wide inventory here. Zeros' native MCP scope can exclude automatic cloud connectors; manage account connections in Claude.",
  };
  if (!query) return { ...result, partial: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const servers = await Promise.race([
      query.mcpServerStatus(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude connector status timed out")),
          5_000,
        );
      }),
    ]);
    const seen = new Set<string>();
    for (const server of servers) {
      const proxy =
        server.config?.type === "claudeai-proxy" ? server.config : null;
      if (!proxy && server.scope !== "claudeai") continue;
      const id = proxy?.id || server.name;
      if (seen.has(id)) continue;
      seen.add(id);
      const status: ExtensionEntry["status"] =
        server.status === "connected"
          ? "available"
          : server.status === "needs-auth"
            ? "needs-auth"
            : server.status === "disabled"
              ? "disabled"
              : server.status === "failed"
                ? "unavailable"
                : "configured";
      result.entries.push({
        id,
        name: server.name,
        description: "Claude account connector",
        sourcePath: "Active Claude session",
        status,
        statusDetail:
          status === "needs-auth"
            ? "Reconnect this account connector in Claude."
            : status === "unavailable"
              ? "The Claude session could not connect. Check this connector in Claude."
              : status === "configured"
                ? "Claude is still connecting. Refresh to check again."
                : status === "disabled"
                  ? "Disabled by the Claude session's configuration."
                  : "Connected in the reporting Claude session. Other sessions can apply different tool permissions.",
      });
    }
    result.entries.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
