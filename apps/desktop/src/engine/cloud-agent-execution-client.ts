import {CloudAgentExecutionAuthoritySchema,CloudAgentExecutionLeaseSchema,CloudAgentActionAuthoritySchema,type CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import type {CloudRuntimeAuthority} from "./cloud-runtime-registration";

export class CloudAgentExecutionError extends Error{
  constructor(){super("Cloud agent execution authority is unavailable");this.name="CloudAgentExecutionError";}
}
/** Same-origin fixed endpoint and bounded body; provider/driver errors never
 * cross the trusted-engine boundary with token or SQL data attached. */
export async function requestCloudAgentExecution(authority:CloudRuntimeAuthority,request:CloudAgentExecutionRequest,
  signal:AbortSignal,requestFetch:typeof fetch=fetch):Promise<unknown>{
  const {heartbeatEndpoint,heartbeatToken,...scope}=authority;
  let response:Response;
  try{
    const endpoint=new URL("/internal/v2/cloud-workspaces/engine/agent-execution",heartbeatEndpoint);
    if(endpoint.protocol!=="https:"&&!(endpoint.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)))throw new CloudAgentExecutionError();
    response=await requestFetch(endpoint,{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]),
      headers:{"content-type":"application/json",authorization:`Bearer ${heartbeatToken}`},body:JSON.stringify({...scope,request})});
  }catch{throw new CloudAgentExecutionError();}
  const limit=response.ok?40*1024:1024;
  if(!response.ok||!response.body||Number(response.headers.get("content-length"))>limit){await response.body?.cancel().catch(()=>{});throw new CloudAgentExecutionError();}
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit)throw new CloudAgentExecutionError();chunks.push(item.value);}
    const document:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
    if(!document||typeof document!=="object"||Array.isArray(document)||Object.keys(document).join()!=="result")throw new CloudAgentExecutionError();
    const value=(document as {result:unknown}).result;
    if(request.kind==="admit"){
      const result=CloudAgentExecutionAuthoritySchema.safeParse(value);
      if(!result.success||result.data.provider!==request.admission.provider||result.data.model!==request.admission.model)throw new CloudAgentExecutionError();
      return result.data;
    }
    if(request.kind==="validate"||request.kind==="refresh-codex"){
      const result=CloudAgentExecutionLeaseSchema.safeParse(value);if(!result.success||result.data.leaseId!==request.leaseId)throw new CloudAgentExecutionError();return result.data;
    }
    if(request.kind==="authorize-action"){
      const result=CloudAgentActionAuthoritySchema.safeParse(value);
      if(!result.success||result.data.executionId!==request.executionId||result.data.actorSessionId!==request.actorSessionId)throw new CloudAgentExecutionError();
      return result.data;
    }
    if(!value||typeof value!=="object"||Object.keys(value).join()!=="released"||(value as {released?:unknown}).released!==true)throw new CloudAgentExecutionError();
    return {released:true};
  }catch{await reader.cancel().catch(()=>{});throw new CloudAgentExecutionError();}finally{reader.releaseLock();}
}
