// MCP servers configured in Zeros for a workspace of several repositories: each
// repository's servers, resolved exactly as for a workspace of one, delivered
// together. An organization-wide server resolves the same for every repository
// and appears once. The same server name configured differently in two
// repositories keeps the first repository's (in the workspace's order) and says
// so in the log, by name only.
import type { Tx } from "../db.js";
import type { McpStore } from "../mcp/store.js";
import type { RuntimeMcpServer } from "./contract.js";
import type { CloudV2Workspace } from "./store.js";
import { otherRepositories } from "./workspace-repositories.js";

const LIMIT = 128;

export function mergeRepositoryMcpServers(perRepository: readonly { repository: string; servers: readonly RuntimeMcpServer[] }[],
  log: (line: string) => void = () => {}): RuntimeMcpServer[] {
  const byName = new Map<string, { server: RuntimeMcpServer; repository: string }>();
  for (const { repository, servers } of perRepository) for (const server of servers) {
    const kept = byName.get(server.name);
    if (!kept) { byName.set(server.name, { server, repository }); continue; }
    if (kept.server.id !== server.id)
      log(`[cloud-v2] mcp server "${server.name}" is configured differently for ${repository}; ${kept.repository}'s is used`);
  }
  const merged = [...byName.values()].map(entry => entry.server);
  if (merged.length > LIMIT) log(`[cloud-v2] mcp servers over ${LIMIT} across the workspace's repositories; the first ${LIMIT} are used`);
  return merged.slice(0, LIMIT);
}

/** The first repository with its admitted identity, then every later one with its own. */
export async function resolveWorkspaceMcpServers(store: Pick<McpStore, "resolve">, tx: Tx, workspace: CloudV2Workspace, userId: string,
  first: { repositoryId: string } | undefined, log?: (line: string) => void): Promise<RuntimeMcpServer[]> {
  const servers = [{ repository: workspace.repository, servers: await store.resolve(workspace.organizationId, userId, workspace.repository, first, tx) }];
  for (const other of await otherRepositories(tx, workspace))
    servers.push({ repository: other.repository,
      servers: await store.resolve(workspace.organizationId, userId, other.repository, { repositoryId: other.repositoryId }, tx) });
  return servers.length === 1 ? servers[0]!.servers.slice() : mergeRepositoryMcpServers(servers, log);
}
