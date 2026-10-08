import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import { executionMcpServers, type CloudProviderExecution } from "../../cloud-provider-execution";
import {cloudClaudeInstructions} from "./cloud-instructions";

/** Same builtin flag layer as Local; repo settings cannot enable it. */
export const CLAUDE_INSTRUCTION_FILES:NonNullable<Settings["pluginConfigs"]>={
  "agents-md@builtin":{options:{instructionFiles:"claude-md-and-agents-md"}},
};

/** Claude uses its native tools on the VM's actual workspace. Product MCP
 * servers add product capabilities; they never replace Read, Edit or Bash. */
export function cloudClaudeTools(execution: CloudProviderExecution,systemInstruction?:string): Partial<Omit<Options,"settings">>&{settings:Settings} {
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
  const append=[systemInstruction,execution.cwd?cloudClaudeInstructions(execution.cwd):undefined].filter(Boolean).join("\n\n");
  return { tools: { type: "preset", preset: "claude_code" },
    ...(execution.lease.customization ? { settingSources: ["user"] as Options["settingSources"] } : {}),
    mcpServers: servers, strictMcpConfig: true,
    settings:{pluginConfigs:CLAUDE_INSTRUCTION_FILES},
    systemPrompt:{type:"preset",preset:"claude_code",snapshot:false,...(append?{append}:{})},
    // A Mac browser connection is not a VM capability. Native shell/browser
    // tools installed in the VM remain available through the normal preset.
    extraArgs: { "no-chrome": null, "thinking-display": "summarized" } };
}
