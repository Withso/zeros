import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {describe,expect,it,vi} from "vitest";
import type {McpSdkServerConfigWithInstance} from "@anthropic-ai/claude-agent-sdk";
import type {CloudProviderExecution} from "../../../cloud-provider-execution";
import {cloudClaudeTools} from "../cloud-tools";

describe("Claude cloud workload tools",()=>{
  it("routes validated native MCP calls to the workload bridge and carries cancellation",async()=>{
    const abort=new AbortController(),lease=new AbortController(),call=vi.fn(async(_input:unknown,_signal:AbortSignal)=>({ok:true,data:{entries:[]}}));
    const options=cloudClaudeTools({tools:{call},lease:{signal:lease.signal},productServers:[]} as unknown as CloudProviderExecution,abort.signal);
    expect(options).toMatchObject({tools:["AskUserQuestion","TodoWrite"],strictMcpConfig:true,settingSources:[],plugins:[]});
    const server=(options.mcpServers!.zeros_workspace as McpSdkServerConfigWithInstance).instance;
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const client=new Client({name:"qualification",version:"1.0.0"});
    try{
      await server.connect(serverTransport);await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(value=>value.name)).toEqual(["workspace"]);
      const result=await client.callTool({name:"workspace",arguments:{request:{operation:"list",path:"."}}});
      expect(result).toMatchObject({isError:false,content:[{type:"text",text:JSON.stringify({ok:true,data:{entries:[]}})}]});
      expect(call.mock.calls[0]?.[0]).toMatchObject({operation:"list",path:".",limit:200});
      const signal=(call.mock.calls as unknown as [unknown,AbortSignal][])[0]![1];
      expect(signal.aborted).toBe(false);lease.abort();expect(signal.aborted).toBe(true);
      const invalid=await client.callTool({name:"workspace",arguments:{request:{operation:"execute-engine",command:"forbidden"}}});
      expect(invalid.isError).toBe(true);expect(call).toHaveBeenCalledOnce();
    }finally{await client.close();await server.close();}
  });
});
