import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ExtensionEntry,
  ExtensionCategory,
  ExtensionInventory,
} from "@zeros/protocol/agent-extensions";
import {
  CLAUDE_CONNECTOR_MEMBERSHIP_UNAVAILABLE,
  selectClaudeSessionConnectors,
  type ClaudeConnectorMembershipReader,
} from "./connector-membership";

/** Read a live SDK control channel. Browsing Customize must not start a Claude
 * conversation or broaden native settings just to discover account connectors. */
export async function readClaudeConnectors(
  query: Pick<Query, "mcpServerStatus"> | null,
  category: ExtensionCategory = "apps",
  readConnectorMembership?: ClaudeConnectorMembershipReader,
): Promise<ExtensionInventory> {
  const result: ExtensionInventory = {
    entries: [],
    warnings: [],
    note: "Claude account connectors are reported by active sessions. The SDK has no separate account-wide inventory here. Zeros' native MCP scope can exclude automatic cloud connectors; manage account connections in Claude.",
  };
  result.sources = [
    {
      id: "session",
      kind: "session",
      state: query ? "complete" : "requires-session",
    },
    {
      id: "account",
      kind: "account",
      state: "unsupported",
      detail:
        "Claude reports connectors visible to a session. It does not expose a separate catalogue of every claude.ai app, skill, and plugin.",
    },
  ];
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
    const selected = await selectClaudeSessionConnectors(
      servers,
      readConnectorMembership,
    );
    if (selected.partial) {
      result.partial = true;
      result.sources![0].state = "partial";
      result.warnings.push(CLAUDE_CONNECTOR_MEMBERSHIP_UNAVAILABLE);
    }
    const seen = new Set<string>();
    for (const server of selected.servers) {
      const proxy =
        server.config?.type === "claudeai-proxy" ? server.config : null;
      if (category === "apps" && !proxy && server.scope !== "claudeai")
        continue;
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
        sourceId: "session",
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

/** Only use reload operations in a disposable discovery query. They must not
 * change a live conversation's plugin set or trigger its startup hooks. */
export async function readClaudeDiscovery(
  query: Query,
  category: ExtensionCategory,
  readConnectorMembership?: ClaudeConnectorMembershipReader,
): Promise<ExtensionInventory> {
  if (category === "apps" || category === "mcp") {
    const result = await readClaudeConnectors(
      query,
      category,
      readConnectorMembership,
    );
    for (const entry of result.entries) {
      entry.sourcePath = "Claude discovery session";
      if (entry.status === "available") entry.status = "configured";
      if (entry.status === "configured")
        entry.statusDetail =
          "Reported by the discovery session. Availability in conversations depends on their MCP settings and permissions.";
    }
    // The SDK does not expose the cloud-fetch outcome separately from an empty
    // status list, and may still be retrying it. Never certify account absence.
    if (
      !result.entries.length ||
      result.entries.some((entry) => entry.status === "configured")
    ) {
      result.partial = true;
      result.sources![0].state = "partial";
    }
    result.note =
      "Claude reports connectors visible to this scope and account. Discovery may connect to configured MCP servers; it does not run a conversation or call their tools. Organization policy and session settings can limit the result.";
    return result;
  }
  const result: ExtensionInventory = {
    entries: [],
    warnings: [],
    sources: [
      { id: "session", kind: "session", state: "complete" },
      {
        id: "account",
        kind: "account",
        state: "unsupported",
        detail:
          "Claude's SDK reports loaded packages. Cloud-only Claude apps, skills, and plugins have no separate account inventory API.",
      },
    ],
    note: "Extensions loaded by Claude for this scope. Account access and local installation can differ between devices.",
  };
  if (category === "skills") {
    const response = await query.reloadSkills();
    result.entries = response.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      sourcePath: "Claude discovery session",
      sourceId: "session",
      status: "configured",
    }));
  } else {
    const response = await query.reloadPlugins();
    result.entries = response.plugins.map((plugin) => ({
      id: `${plugin.name}:${plugin.path}`,
      name: plugin.name,
      description: plugin.version ? `Version ${plugin.version}` : "",
      sourcePath: plugin.path,
      sourceId: "session",
      status: "configured",
    }));
    if (response.error_count) {
      result.partial = true;
      result.sources![0].state = "partial";
      result.warnings.push(
        "Some Claude plugins could not be loaded. Refresh to retry.",
      );
    }
  }
  result.entries.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
