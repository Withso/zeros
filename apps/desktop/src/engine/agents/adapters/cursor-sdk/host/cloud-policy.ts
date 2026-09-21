import type {CloudProviderExecution} from "../../../cloud-provider-execution";
import type {McpServerConfig as CursorMcpConfig} from "@cursor/sdk";
const CWD="/srv/zeros/workspace";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Applied at the sole engine→private-host boundary, including resume,
 * recovery, prewarm and metadata probes. Caller configuration cannot widen the
 * private native toolset or change the admitted credential/model. */
export function cloudCursorRequest(execution:CloudProviderExecution,operation:string,raw:unknown):unknown{
  execution.lease.assertLive();const args=record(raw);
  const apiKey=execution.coordinator.environment().CURSOR_API_KEY;
  if(!apiKey)throw new Error("Cloud Cursor credential is unavailable");
  const model=(value:unknown)=>{
    if(value===undefined)return {id:execution.lease.admission.model};
    const selected=record(value);
    if(selected.id!==execution.lease.admission.model)throw new Error("Cloud model changes require a new credential admission");
    if(selected.params!==undefined&&(!Array.isArray(selected.params)||selected.params.length>16||selected.params.some(value=>{
      const parameter=record(value);
      return typeof parameter.id!=="string"||parameter.id.length>128||typeof parameter.value!=="string"||parameter.value.length>256;
    })))throw new Error("Cloud model parameters are invalid");
    return {id:execution.lease.admission.model,...(Array.isArray(selected.params)?{params:selected.params.map(value=>({id:record(value).id,value:record(value).value}))}: {})};
  };
  const mode=(value:unknown)=>{
    if(value===undefined)return {};
    if(value!=="agent"&&value!=="plan")throw new Error("Cloud Cursor mode is invalid");
    return {mode:value};
  };
  const options=(value:unknown)=>{
    const original=record(value),mcpServers:Record<string,CursorMcpConfig>={};
    for(const server of execution.productServers){
      if(server.transport==="stdio")throw new Error("Cloud product tool registration is invalid");
      mcpServers[server.name]={url:server.url,...(server.headers?{headers:server.headers}:{})};
    }
    return {apiKey,model:model(original.model),cwd:CWD,tools:["mcp","askQuestion","updateTodos","readTodos"],
      local:{cwd:CWD,settingSources:[],enableAgentRetries:false},
      ...mode(original.mode),mcpServers,
      zerosWorkloadTools:{inputSchema:execution.tools.inputSchema}};
  };
  switch(operation){
    case "agent.create":case "platform.prewarm":return options(args);
    case "agent.resume":return {agentId:args.agentId,opts:options(args.opts)};
    case "agent.send":{
      const send=record(args.options);
      return {agentId:args.agentId,handleId:args.handleId,runId:args.runId,message:args.message,
        ...(args.observers?{observers:{delta:record(args.observers).delta===true,step:record(args.observers).step===true}}:{}),
        options:{model:model(send.model),...mode(send.mode),
          ...(typeof send.idempotencyKey==="string"&&send.idempotencyKey.length<=256?{idempotencyKey:send.idempotencyKey}:{}),
          // A recovery force is conversation bookkeeping; custom tool/MCP
          // replacements and native environment options remain excluded.
          ...(record(send.local).force===true?{local:{force:true}}:{})}};
    }
    case "models.list":return {opts:{apiKey}};
    case "agent.list":return {opts:{runtime:"local",cwd:CWD,apiKey}};
    case "store.open":return {cwd:CWD};
    default:return args;
  }
}
