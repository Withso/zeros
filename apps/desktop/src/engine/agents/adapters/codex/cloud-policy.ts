import {executionMcpServers,type CloudProviderExecution} from "../../cloud-provider-execution";
import type {DynamicToolCallParams} from "./generated/v2/DynamicToolCallParams";
import type {DynamicToolCallResponse} from "./generated/v2/DynamicToolCallResponse";
import { z } from "zod";
import { CloudGoalUpdateSchema } from "@zeros/protocol/cloud-commands";
import {cloudComputerProcessEnvironment} from "../../cloud-computer-environment";
const cwd="/srv/zeros/workspace";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const reads=new Set(["model/list","account/read","account/rateLimits/read","config/read","configRequirements/read","permissionProfile/list",
  "mcpServerStatus/list","thread/read","thread/list","thread/loaded/list","thread/backgroundTerminals/list","skills/list"]);
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
  "shell_environment_policy.inherit":"none",
  // This is inside the per-conversation locked mount; disposable HOME never
  // retains login material. Codex owns goal/job counters and their migrations.
  sqlite_home:"/srv/zeros/home/agent/.codex/sessions/.zeros-state",
  "features.multi_agent":false,
  "mcp_servers.codex_apps.enabled":false,
  "mcp_servers.codex_apps.command":"zeros-disabled-mcp-server",
};
const nativeThreads = new WeakMap<CloudProviderExecution, string>();
/** Called only after native start/resume, or by the admitted fork adapter.
 * A renderer-provided thread id never creates this binding. */
export function bindCloudCodexThread(execution: CloudProviderExecution, threadId: string): void {
  execution.lease.assertLive();
  if (!threadId || threadId.length > 256) throw new Error("Invalid native conversation");
  const previous = nativeThreads.get(execution);
  if (previous && previous !== threadId) throw new Error("Cloud native conversation changed");
  nativeThreads.set(execution, threadId);
}
export function cloudCodexCapabilities(execution: CloudProviderExecution) {
  execution.lease.assertLive();
  const admitted=execution.lease.nativeCapabilities;
  return { version: 1 as const, goals: admitted?.goals===true, nativeReview: admitted?.nativeReview===true, nativeFork: admitted?.nativeFork===true,
    connectedApps: admitted?.connectedApps===true && !!execution.lease.codexAuth?.(), multiAgent: admitted?.multiAgent===true };
}
export function cloudCodexConfig(execution: CloudProviderExecution): Record<string, unknown> {
  const config: Record<string, unknown> = {...CLOUD_CODEX_CONFIG};
  if(execution.lease.environment){
    // These config entries also reach app-server argv: pass names only. The
    // executor inherits values from its private, credential-free launch env.
    const names=Object.keys(cloudComputerProcessEnvironment({},execution.lease.environment.values,"agent"));
    config["shell_environment_policy.inherit"]="all";
    config["shell_environment_policy.ignore_default_excludes"]=true;
    config["shell_environment_policy.include_only"]=["HOME","PATH","LANG","SHELL","TMPDIR","USER","LOGNAME",...names];
  }
  config["features.multi_agent"]=cloudCodexCapabilities(execution).multiAgent;
  if (cloudCodexCapabilities(execution).connectedApps) {
    delete config["mcp_servers.codex_apps.enabled"];
    delete config["mcp_servers.codex_apps.command"];
    config["features.apps"] = true;
  }
  return config;
}
function ownThread(execution: CloudProviderExecution, value: unknown): string {
  if (typeof value !== "string" || nativeThreads.get(execution) !== value)
    throw new Error("This native provider operation is not admitted for this conversation");
  return value;
}
/** No caller can clear the remote environment or change admitted model/auth.
 * Host process/fs/config mutation RPCs have no cloud-facing route. */
export function cloudCodexRequest(execution:CloudProviderExecution,environmentId:string,method:string,input:unknown):unknown{
  execution.lease.assertLive();const params=record(input),model=execution.lease.admission.model;
  if(params.model!==undefined&&params.model!==null&&params.model!==model)throw new Error("Cloud model changes require a new credential admission");
  const environments=[{environmentId,cwd,runtimeWorkspaceRoots:[cwd]}];
  const servers=executionMcpServers(execution,[])??[];
  const kept=new Set(servers.map(server=>server.name));
  const config=Object.fromEntries(Object.entries(record(params.config)).filter(([name,value])=>
    /^mcp_servers\.[A-Za-z0-9_-]+\.enabled$/.test(name)&&value===false&&!kept.has(name.slice(12,-8))));
  const disabled:Record<string,unknown>=Object.create(null);
  const nativeServers=Object.entries(record(record(params.config).mcp_servers));
  if(nativeServers.length>128)throw new Error("Cloud native configuration exceeds its limit");
  for(const [name,value] of nativeServers){
    if(name.length<=256&&record(value).enabled===false&&!kept.has(name))
      disabled[name]={enabled:false,command:"zeros-disabled-mcp-server"};
  }
  for(const name of Object.keys(config))config[name.replace(/\.enabled$/,".command")]="zeros-disabled-mcp-server";
  for(const server of servers){
    if(server.transport==="sse")throw new Error("Cloud SSE MCP requires its admitted stdio relay");
    disabled[server.name]=server.transport==="stdio"?{enabled:true,command:server.command,args:server.args??[],env:server.env??{},...(server.cwd?{cwd:server.cwd}:{})}:
      {enabled:true,url:server.url,http_headers:server.headers??{}};
  }
  // RPC config maps must carry the complete disabled definition too. A dotted
  // codex_apps override beside a nested mcp_servers map loses its transport in
  // the pinned native loader. Connected Apps still owns its admitted built-in.
  if (!cloudCodexCapabilities(execution).connectedApps) disabled.codex_apps={enabled:false,command:"zeros-disabled-mcp-server"};
  // The VM/workspace boundary is fixed; approval remains the user's native
  // selection. Never turn Ask/Read-only into unattended full access.
  const approvalPolicy = ["untrusted","on-request","never"].includes(String(params.approvalPolicy)) ? params.approvalPolicy : "untrusted";
  const sandbox = ["read-only","workspace-write","danger-full-access"].includes(String(params.sandbox)) ? params.sandbox : "workspace-write";
  const selected = record(params.sandboxPolicy);
  const sandboxPolicy = selected.type === "dangerFullAccess" ? {type:"dangerFullAccess"}
    : selected.type === "readOnly" ? {type:"readOnly",networkAccess:false}
    : {type:"workspaceWrite",writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
  if(method==="thread/start"||method==="thread/resume"||method==="thread/fork"){
    if(method==="thread/fork") {
      if(!cloudCodexCapabilities(execution).nativeFork)throw new Error("This native provider operation is not admitted for this account and image");
      ownThread(execution,params.threadId);
    }
    return {...pick(params,["serviceTier","baseInstructions","developerInstructions","personality",...(method==="thread/start"?["historyMode"]:["threadId","excludeTurns"])]),
      model,modelProvider:"openai",allowProviderModelFallback:false,cwd,runtimeWorkspaceRoots:[cwd],config:{...config,...cloudCodexConfig(execution),...(Object.keys(disabled).length?{mcp_servers:disabled}:{})},
      ...(method==="thread/fork"?{ephemeral:false,excludeTurns:true,deferGoalContinuation:true}:{}),
      ...(method==="thread/start"?{environments}:{environments:undefined}),
      sandbox,permissions:undefined,approvalPolicy,serviceName:undefined,experimentalRawEvents:false};
  }
  if(method==="turn/start"){
    const collaboration=record(params.collaborationMode),settings=record(collaboration.settings);
    return {...pick(params,["threadId","clientUserMessageId","effort","summary","serviceTier","serviceTierForTurn","personality","outputSchema"]),
      input:safeInput(params.input),model,cwd,environments,runtimeWorkspaceRoots:[cwd],
      sandboxPolicy,approvalPolicy,permissions:undefined,
      collaborationMode:params.collaborationMode?{mode:collaboration.mode==="plan"?"plan":"default",settings:{
        model,reasoning_effort:settings.reasoning_effort??params.effort??null,
        developer_instructions:typeof settings.developer_instructions==="string"?settings.developer_instructions:null}}:undefined};
  }
  if(method==="thread/settings/update")return {threadId:params.threadId,model,
    ...(params.serviceTier === null || params.serviceTier === "fast" ? {serviceTier:params.serviceTier} : {}),
    ...(typeof params.effort==="string"&&["low","medium","high","xhigh","max","ultra"].includes(params.effort)?{effort:params.effort}:{})};
  if(method==="turn/steer")return {...pick(params,["threadId","expectedTurnId"]),input:safeInput(params.input)};
  if(method.startsWith("thread/goal/")) {
    if(!cloudCodexCapabilities(execution).goals)throw new Error("This native provider operation is not admitted for this account and image");
    const threadId=ownThread(execution,params.threadId);
    if(method==="thread/goal/get"||method==="thread/goal/clear")return z.object({threadId:z.literal(threadId)}).strict().parse(params);
    if(method==="thread/goal/set") {
      const {threadId:_thread,...update}=params;
      return {threadId,...CloudGoalUpdateSchema.parse(update)};
    }
  }
  if(method==="review/start") {
    if(!cloudCodexCapabilities(execution).nativeReview)throw new Error("This native provider operation is not admitted for this account and image");
    const threadId=ownThread(execution,params.threadId);
    // The shared /review command reviews this workspace. Detached reviews own
    // another native thread and require their own admission.
    return z.object({threadId:z.literal(threadId),target:z.object({type:z.literal("uncommittedChanges")}).strict(),delivery:z.literal("inline")}).strict().parse(params);
  }
  if((method==="app/list"||method==="app/installed"||method==="app/read")&&cloudCodexCapabilities(execution).connectedApps) {
    if(params.threadId!==undefined)ownThread(execution,params.threadId);
    if(method==="app/read")return z.object({threadId:z.string(),appIds:z.array(z.string().min(1).max(512)).max(100),includeTools:z.literal(false)}).strict().parse(params);
    return method==="app/list"
      ? z.object({threadId:z.string().optional(),cursor:z.string().max(8192).nullable().optional(),limit:z.number().int().min(1).max(100).optional(),forceRefetch:z.boolean().optional()}).strict().parse(params)
      : z.object({threadId:z.string().optional(),forceRefresh:z.boolean().optional()}).strict().parse(params);
  }
  if(reads.has(method)||controls.has(method))return params;
  throw new Error("This native provider operation is not admitted for cloud execution");
}
