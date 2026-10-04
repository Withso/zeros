import type {
  AccountInfo,
  McpServerStatus,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import type {
  SessionToolsSnapshot,
  SessionToolsInventorySnapshot,
  SessionToolGroup,
} from "@zeros/protocol/agent-extensions";
import {
  CLAUDE_CONNECTOR_MEMBERSHIP_UNAVAILABLE,
  isClaudeAccountConnector,
  selectClaudeSessionConnectors,
  type ClaudeConnectorMembershipReader,
} from "./connector-membership";

function missingAccountConnectors(account: AccountInfo | null): string {
  if (
    (account?.apiProvider && account.apiProvider !== "firstParty") ||
    (account?.apiKeySource && account.apiKeySource !== "none") ||
    account?.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN"
  ) {
    return "No account connectors reported. Automatic account connectors require a Claude subscription login with connector access. Check Claude authentication in Settings, then reopen this chat.";
  }
  if (account?.tokenSource === "none") {
    return "Sign in to Claude Code with the same Claude subscription account to load its connectors, then reopen this chat.";
  }
  // Account metadata is not a completion receipt for the background cloud
  // fetch. Neither an empty list nor successful model auth proves absence.
  return "Claude has not reported any account connectors yet. Refresh to check again. If a connected service stays missing, check the Claude subscription account and reopen this chat.";
}

/** Claude configuration scopes read from settings files on this machine:
 *  `~/.claude.json`, a repository `.mcp.json`, or Claude's per-project scope.
 *  Servers Zeros registers report `dynamic`; plugin servers report `plugin`. */
const LOCAL_CONFIG_SCOPES = new Set(["user", "project", "local"]);

function isLocalConfigServer(server: McpServerStatus): boolean {
  return LOCAL_CONFIG_SCOPES.has(server.source ?? server.scope ?? "");
}

export async function readClaudeSessionTools(
  query: Pick<Query, "mcpServerStatus"> & Partial<Pick<Query, "accountInfo">>,
  {
    accountConnectorsEnabled = true,
    readConnectorMembership,
    includeInventory = false,
    plugins,
    markLocalServers = false,
  }: {
    accountConnectorsEnabled?: boolean;
    readConnectorMembership?: ClaudeConnectorMembershipReader;
    includeInventory?: boolean;
    plugins?: SessionToolGroup;
    /** Tag servers from Claude's own settings files for the Local folder. */
    markLocalServers?: boolean;
  } = {},
): Promise<SessionToolsInventorySnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let accountTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Account information is advisory. A slow or failed metadata read must
    // not discard confirmed MCP status. Never return identity or raw errors.
    const account =
      accountConnectorsEnabled && query.accountInfo
        ? Promise.race([
            Promise.resolve()
              .then(() => query.accountInfo!())
              .catch(() => null),
            new Promise<null>((resolve) => {
              accountTimer = setTimeout(() => resolve(null), 1_000);
            }),
          ])
        : Promise.resolve(null);
    const servers = await Promise.race([
      query.mcpServerStatus(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tool status timed out.")),
          5_000,
        );
      }),
    ]);
    const selected = await selectClaudeSessionConnectors(
      servers,
      accountConnectorsEnabled ? readConnectorMembership : undefined,
    );
    const missingCloud =
      accountConnectorsEnabled && !servers.some(isClaudeAccountConnector);
    const snapshot: SessionToolsSnapshot = {
      state: "ready",
      entries: selected.servers
        .filter((server) => server.status !== "disabled")
        .slice(0, 1_000)
        .map((server) => ({
          id: server.name,
          name: server.name,
          status:
            server.status === "connected"
              ? "connected"
              : server.status === "pending"
                ? "connecting"
                : server.status === "needs-auth"
                  ? "needs-auth"
                  : "error",
          // The Query API reports needs-auth but exposes no MCP OAuth launcher.
          // Do not turn untrusted errors/config URLs into browser actions.
          ...(server.status === "needs-auth"
            ? {
                detail: "Authenticate this connection in Claude, then refresh.",
              }
            : {}),
        })),
      ...(missingCloud
        ? ({
            state: "partial",
            detail: missingAccountConnectors(await account),
          } as const)
        : {}),
      ...(selected.partial
        ? { state: "partial", detail: CLAUDE_CONNECTOR_MEMBERSHIP_UNAVAILABLE }
        : {}),
      ...(selected.servers.length > 1_000
        ? {
            state: "partial",
            detail: "The provider returned an incomplete tool list.",
          }
        : {}),
    };
    if (!includeInventory) return snapshot;
    // Preserve provider provenance from the status response. A name or an
    // HTTPS transport cannot distinguish account connectors from local MCPs.
    const accountNames = new Set(
      selected.servers
        .filter(isClaudeAccountConnector)
        .map((server) => server.name),
    );
    const localNames = new Set(
      markLocalServers
        ? selected.servers
            .filter(
              (server) =>
                isLocalConfigServer(server) && !isClaudeAccountConnector(server),
            )
            .map((server) => server.name)
        : [],
    );
    return {
      ...snapshot,
      groups: [
        plugins ?? {
          kind: "plugins",
          state: "unsupported",
          entries: [],
          detail: "Claude has not reported this session’s loaded plugins yet.",
        },
        {
          kind: "apps",
          state: snapshot.state === "ready" ? "ready" : "partial",
          detail:
            "Connected Claude account services visible to this chat. Their MCP connections also appear in MCPs.",
          entries: snapshot.entries.filter((entry) =>
            accountNames.has(entry.id),
          ),
        },
        {
          kind: "mcp",
          state: snapshot.state === "ready" ? "ready" : "partial",
          // The legacy top-level list stays strict; only grouped rows carry
          // their configuration source.
          entries: snapshot.entries.map((entry) =>
            localNames.has(entry.id)
              ? { ...entry, source: "local" as const }
              : entry,
          ),
          ...(snapshot.detail ? { detail: snapshot.detail } : {}),
        },
      ],
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (accountTimer) clearTimeout(accountTimer);
  }
}

/** Consume the live query's system/init receipt. Opening Tools must not call
 * reloadPlugins(), which changes the running session just to list metadata. */
export function claudeSessionPluginGroup(value: unknown): SessionToolGroup {
  if (!Array.isArray(value))
    return {
      kind: "plugins",
      state: "unsupported",
      entries: [],
      detail: "Claude has not reported this session’s loaded plugins yet.",
    };
  const entries = new Map<string, SessionToolGroup["entries"][number]>();
  let partial = value.length > 1000;
  for (const plugin of value.slice(0, 1000)) {
    if (
      !plugin ||
      typeof plugin.name !== "string" ||
      !plugin.name.trim() ||
      typeof plugin.path !== "string"
    ) {
      partial = true;
      continue;
    }
    const id = createHash("sha256")
      .update(JSON.stringify([plugin.name, plugin.path]))
      .digest("hex");
    entries.set(id, {
      id,
      name: plugin.name.trim().slice(0, 512),
      status: "loaded",
      detail:
        "Loaded by this Claude session. Component connections are listed separately.",
    });
  }
  return {
    kind: "plugins",
    state: partial ? "partial" : "ready",
    entries: [...entries.values()],
  };
}
