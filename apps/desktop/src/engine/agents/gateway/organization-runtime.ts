import { gatewayRegistration, type McpGatewayEndpoint } from "./capability";
import { createHash, randomUUID } from "node:crypto";
import { mcpSecretEnvAlias } from "@zeros/protocol/mcp-secrets";
import type { McpServerRegistration } from "../types";
import type { GatewayBackend } from "../mcp-registry";
import type { McpHostControl } from "./host-control";

export interface McpWorkspaceIdentity {
  organizationId?: string | null;
  placement?: "local" | "cloud";
  repoRoot: string;
  path: string;
}
interface Dependencies {
  host: Pick<McpHostControl, "generation" | "isCurrent" | "resolve" | "authorize">;
  workspace: (id: string) => McpWorkspaceIdentity | undefined;
  repository: (repoRoot: string) => Promise<string>;
  gateway: (key: string, backends: GatewayBackend[]) => Promise<McpGatewayEndpoint>;
  removeGateway: (key: string) => Promise<void>;
}

/** Definitions and per-user authorizations come only from the admitted
 * workspace's organisation. Personal device settings never enter this path. */
export class OrganizationMcpRuntime {
  private readonly admissions = new Map<string, { id: string; controller: AbortController; identity: string }>();
  constructor(private readonly deps: Dependencies) {}
  async resolve(workspaceId: string, env: Record<string, string>, signal?: AbortSignal): Promise<McpServerRegistration[]> {
    const workspace = this.deps.workspace(workspaceId);
    if (!workspace?.organizationId || workspace.placement === "cloud") throw new Error("This MCP runtime requires a Local organisation workspace.");
    const identity = JSON.stringify(workspace);
    let entry = this.admissions.get(workspaceId);
    if (entry && entry.identity !== identity) { await this.remove(workspaceId); entry = undefined; }
    if (!entry) {
      if (this.admissions.size >= 64) throw new Error("Too many active MCP workspaces.");
      entry = { id: randomUUID(), controller: new AbortController(), identity };
      this.admissions.set(workspaceId, entry);
    }
    const admission = entry;
    const generation = this.deps.host.generation;
    const requestSignal = signal ? AbortSignal.any([signal, admission.controller.signal]) : admission.controller.signal;
    const stillOwned = () => !admission.controller.signal.aborted && this.admissions.get(workspaceId) === admission && JSON.stringify(this.deps.workspace(workspaceId)) === identity;
    const repository = await this.deps.repository(workspace.repoRoot);
    requestSignal.throwIfAborted();
    if (!stillOwned()) throw new Error("The MCP workspace changed. Try again.");
    const request = { organizationId: workspace.organizationId, repository, runtimeId: admission.id };
    const resolved = await this.deps.host.resolve(request, requestSignal);
    const current = () => stillOwned() && this.deps.host.isCurrent(generation, resolved.accountId);
    if (!current()) throw new Error("The MCP account or workspace changed. Try again.");
    const servers: McpServerRegistration[] = [];
    const backends: GatewayBackend[] = [];
    const variables: Record<string, string> = {};
    for (const server of resolved.servers) {
      if (server.transport === "stdio") {
        const envFromEnv: Record<string, string> = {};
        for (const [name, value] of Object.entries(server.env ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name) || value.includes("\0")) throw new Error("Invalid MCP variable.");
          const alias = mcpSecretEnvAlias(server.id, name);
          envFromEnv[name] = alias; variables[alias] = value;
        }
        servers.push({ name: server.name, transport: "stdio", command: server.command,
          ...(server.args ? { args: server.args } : {}), ...(server.cwd ? { cwd: server.cwd } : {}),
          ...(server.listen_url ? { listenUrl: server.listen_url } : {}),
          ...(Object.keys(envFromEnv).length ? { envFromEnv } : {}),
        });
      } else {
        backends.push({ name: server.name, transport: server.transport, url: server.url,
          auth: server.auth === "oauth" ? "oauth" : "header", source: "user",
          disabledTools: server.disabled_tools,
          authorizationKey: JSON.stringify([generation, resolved.accountId, admission.id, createHash("sha256").update(JSON.stringify(server)).digest("hex")]),
          authorization: async (force, signal) => {
            if (!current()) throw new Error("The MCP account or workspace changed. Reopen the session.");
            const response = await this.deps.host.authorize(request, server.id, resolved.accountId, force,
              signal ? AbortSignal.any([signal, admission.controller.signal]) : admission.controller.signal);
            if (!current()) throw new Error("The MCP account or workspace changed. Reopen the session.");
            return response.headers;
          },
        });
      }
    }
    const key = `organization:${workspaceId}`;
    if (backends.length) {
      const endpoint = await this.deps.gateway(key, backends);
      servers.unshift(gatewayRegistration(endpoint, variables));
    } else await this.deps.removeGateway(key);
    if (!current()) { await this.deps.removeGateway(key); throw new Error("The MCP account or workspace changed. Try again."); }
    requestSignal.throwIfAborted();
    Object.assign(env, variables);
    return servers;
  }
  async remove(workspaceId: string): Promise<void> {
    this.admissions.get(workspaceId)?.controller.abort();
    this.admissions.delete(workspaceId);
    await this.deps.removeGateway(`organization:${workspaceId}`);
  }
  async reset(): Promise<void> { await Promise.all([...this.admissions.keys()].map(id => this.remove(id))); }
}
