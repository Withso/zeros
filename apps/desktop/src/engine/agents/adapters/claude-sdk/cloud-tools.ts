import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { executionMcpServers, type CloudProviderExecution } from "../../cloud-provider-execution";

/** Claude uses its native tools on the VM's actual workspace. Product MCP
 * servers add product capabilities; they never replace Read, Edit or Bash. */
export function cloudClaudeTools(execution: CloudProviderExecution): Partial<Options> {
  execution.lease.assertLive();
  const servers: NonNullable<Options["mcpServers"]> = {};
  for (const server of executionMcpServers(execution, [])!) {
    if (server.name === "zeros_workspace")
      throw new Error("Cloud product tool registration is invalid");
    if (server.transport === "stdio") {
      servers[server.name] = { type: "stdio", command: server.cwd ? "/usr/bin/env" : server.command,
        args: server.cwd ? [`--chdir=${server.cwd}`, "--", server.command, ...(server.args ?? [])] : server.args,
        ...(server.env ? { env: server.env } : {}) };
      continue;
    }
    servers[server.name] = { type: server.transport, url: server.url,
      ...(server.headers ? { headers: server.headers } : {}) };
  }
  return { tools: { type: "preset", preset: "claude_code" },
    ...(execution.lease.customization ? { settingSources: ["user"] as Options["settingSources"] } : {}),
    mcpServers: servers, strictMcpConfig: true,
    // A Mac browser connection is not a VM capability. Native shell/browser
    // tools installed in the VM remain available through the normal preset.
    extraArgs: { "thinking-display": "summarized" } };
}
