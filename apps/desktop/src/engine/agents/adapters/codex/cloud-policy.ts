import type {CloudProviderExecution} from "../../cloud-provider-execution";
import type {DynamicToolCallParams} from "./generated/v2/DynamicToolCallParams";
import type {DynamicToolCallResponse} from "./generated/v2/DynamicToolCallResponse";
const cwd="/srv/zeros/workspace";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const reads=new Set(["model/list","account/read","account/rateLimits/read","config/read","configRequirements/read","permissionProfile/list",
  "mcpServerStatus/list","thread/read","thread/list","thread/loaded/list","thread/backgroundTerminals/list","thread/goal/get","skills/list"]);
const controls=new Set(["turn/steer","thread/name/set","thread/compact/start","thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/terminate","thread/unsubscribe"]);
const pick=(params:Record<string,unknown>,names:readonly string[])=>Object.fromEntries(names.filter(name=>params[name]!==undefined).map(name=>[name,params[name]]));
export async function cloudCodexToolCall(execution:CloudProviderExecution,input:DynamicToolCallParams):Promise<DynamicToolCallResponse>{
  try{
    execution.lease.assertLive();
    if(input.namespace!==null||input.tool!=="zeros_workspace")throw new Error("Unregistered cloud tool");
    const result=await execution.tools.call(input.arguments,execution.lease.signal);execution.lease.assertLive();
    return {success:result.ok,contentItems:[{type:"inputText",text:JSON.stringify(result)}]};
  }catch{return {success:false,contentItems:[{type:"inputText",text:"Cloud workspace tool is unavailable."}]};}
}
/** The private coordinator must never ingest paths from the engine's filesystem.
 * Inline images also survive reconnects without exposing temporary host paths. */
export function cloudCodexImage(data:string,mimeType:unknown):{type:"image";url:string}{
  if(typeof mimeType!=="string"||!["image/png","image/jpeg","image/webp","image/gif"].includes(mimeType)||
    data.length===0||data.length>16*1024*1024||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)||Buffer.from(data,"base64").toString("base64")!==data)
    throw new Error("Unsupported cloud image input");
  return {type:"image",url:`data:${mimeType};base64,${data}`};
}
function safeInput(value:unknown):unknown{
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length>128)throw new Error("Unsupported cloud input");
  return value.map(entry=>{
    const item=record(entry);
    if(item.type==="text"&&typeof item.text==="string")return {type:"text",text:item.text,text_elements:[]};
    if(item.type==="image"&&typeof item.url==="string"){
      const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/.exec(item.url);
      if(match)return cloudCodexImage(match[2]!,match[1]);
    }
    throw new Error("Cloud inputs cannot reference private coordinator paths");
  });
}
export const CLOUD_CODEX_CONFIG={
  "features.multi_agent":false,"features.apps":false,"features.hooks":false,"features.js_repl":false,
  "features.js_repl_tools_only":false,"features.memories":false,"features.remote_control":false,
  "plugins.browser@openai-bundled.enabled":false,"shell_environment_policy.inherit":"none",
  "mcp_servers.codex_apps.enabled":false,
  "mcp_servers.codex_apps.command":"zeros-disabled-mcp-server",
};
/** No caller can clear the remote environment or change admitted model/auth.
 * Host process/fs/config mutation RPCs have no cloud-facing route. */
export function cloudCodexRequest(execution:CloudProviderExecution,environmentId:string,method:string,input:unknown):unknown{
  execution.lease.assertLive();const params=record(input),model=execution.lease.admission.model;
  if(params.model!==undefined&&params.model!==null&&params.model!==model)throw new Error("Cloud model changes require a new credential admission");
  const environments=[{environmentId,cwd,runtimeWorkspaceRoots:[cwd]}];
  const config=Object.fromEntries(Object.entries(record(params.config)).filter(([name,value])=>
    /^mcp_servers\.[A-Za-z0-9_-]+\.enabled$/.test(name)&&value===false));
  const disabled:Record<string,unknown>=Object.create(null);
  const kept=new Set(execution.productServers?.map(server=>server.name)??[]);
  const nativeServers=Object.entries(record(record(params.config).mcp_servers));
  if(nativeServers.length>128)throw new Error("Cloud native configuration exceeds its limit");
  for(const [name,value] of nativeServers){
    if(name.length<=256&&record(value).enabled===false&&!kept.has(name))
      disabled[name]={enabled:false,command:"zeros-disabled-mcp-server"};
  }
  for(const name of Object.keys(config))config[name.replace(/\.enabled$/,".command")]="zeros-disabled-mcp-server";
  if(method==="thread/start"||method==="thread/resume"){
    return {...pick(params,["serviceTier","baseInstructions","developerInstructions","personality",...(method==="thread/start"?["historyMode"]:["threadId","excludeTurns"])]),
      model,modelProvider:"openai",allowProviderModelFallback:false,cwd,runtimeWorkspaceRoots:[cwd],config:{...config,...CLOUD_CODEX_CONFIG,...(nativeServers.length?{mcp_servers:disabled}:{})},
      ...(method==="thread/start"?{dynamicTools:[{type:"function",name:"zeros_workspace",inputSchema:execution.tools.inputSchema,
        description:"Read, list, search and edit workspace files, run commands, or use disk-backed TypeScript/JavaScript/Python language symbols and completions. LSP positions use zero-based UTF-16 columns. Use returned SHA-256 values for edits."}]}:{}),
      ...(method==="thread/start"?{environments}:{environments:undefined}),
      sandbox:"danger-full-access",permissions:undefined,approvalPolicy:"never",serviceName:undefined,experimentalRawEvents:false};
  }
  if(method==="turn/start"){
    const collaboration=record(params.collaborationMode),settings=record(collaboration.settings);
    return {...pick(params,["threadId","clientUserMessageId","effort","summary","serviceTier","serviceTierForTurn","personality","outputSchema"]),
      input:safeInput(params.input),model,cwd,environments,runtimeWorkspaceRoots:[cwd],
      sandboxPolicy:{type:"dangerFullAccess"},approvalPolicy:"never",permissions:undefined,
      collaborationMode:params.collaborationMode?{mode:collaboration.mode==="plan"?"plan":"default",settings:{
        model,reasoning_effort:settings.reasoning_effort??params.effort??null,
        developer_instructions:typeof settings.developer_instructions==="string"?settings.developer_instructions:null}}:undefined};
  }
  if(method==="thread/settings/update")return {threadId:params.threadId,model,
    ...(typeof params.effort==="string"&&["low","medium","high","xhigh"].includes(params.effort)?{effort:params.effort}:{})};
  if(method==="turn/steer")return {...pick(params,["threadId","expectedTurnId"]),input:safeInput(params.input)};
  if(reads.has(method)||controls.has(method))return params;
  throw new Error("This native provider operation is not admitted for cloud execution");
}
