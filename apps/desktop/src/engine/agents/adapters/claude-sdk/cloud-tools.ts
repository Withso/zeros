import {createSdkMcpServer,tool,type Options} from "@anthropic-ai/claude-agent-sdk";
import {CloudAgentToolInputSchema} from "@zeros/protocol/cloud-agent-tools";
import type {CloudProviderExecution} from "../../cloud-provider-execution";

/** Native filesystem/shell/plugin tools must never run in the credential view.
 * Only question/checklist tools stay native. Workload calls cross the trusted
 * engine callback, where both actor authority and process ownership are checked. */
export function cloudClaudeTools(execution:CloudProviderExecution,signal:AbortSignal):Partial<Options>{
  const workspace=tool("workspace","Read, list, search, compare-and-edit workspace files, run and monitor workspace commands, or use disk-backed TypeScript/JavaScript/Python language symbols and completions. LSP positions use zero-based UTF-16 columns. Use the returned SHA-256 for edits. Output is UTF-8 unless its encoding is base64. Paths belong to the workspace, not the private provider runtime.",
    {request:CloudAgentToolInputSchema},async({request},extra)=>{
      const caller=extra&&typeof extra==="object"&&"signal" in extra&&extra.signal instanceof AbortSignal?extra.signal:null;
      const result=await execution.tools.call(request,AbortSignal.any([signal,execution.lease.signal,...(caller?[caller]:[])]));
      return {content:[{type:"text",text:JSON.stringify(result)}],isError:!result.ok};
    });
  const servers:NonNullable<Options["mcpServers"]>={};
  for(const server of execution.productServers){
    if(server.transport==="stdio"||server.name==="zeros_workspace")throw new Error("Cloud product tool registration is invalid");
    servers[server.name]={type:server.transport,url:server.url,...(server.headers?{headers:server.headers}:{})};
  }
  servers.zeros_workspace=createSdkMcpServer({name:"zeros_workspace",version:"1.0.0",tools:[workspace]});
  return {
    tools:["AskUserQuestion","TodoWrite"],mcpServers:servers,strictMcpConfig:true,settingSources:[],plugins:[],
    hooks:undefined,agents:undefined,agent:undefined,
    extraArgs:{"thinking-display":"summarized"},
  };
}
