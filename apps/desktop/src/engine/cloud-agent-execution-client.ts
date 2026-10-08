import { isCloudAgentAdmissionCode, type CloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import {CloudAgentExecutionAuthoritySchema,CloudAgentExecutionLeaseSchema,CloudAgentActionAuthoritySchema,CloudBackgroundStateSchema,CloudComputerTerminalEnvironmentSchema,type CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import type {CloudRuntimeAuthority} from "./cloud-runtime-registration";
import { CloudCustomizationResultSchema } from "@zeros/protocol/cloud-customization";
import { CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES, CloudComputerToolConflictSchema, CloudComputerToolResultSchemas } from "@zeros/protocol/cloud-computer-tools";
import { encodeCloudCommandFailure, decodeCloudCommandFailure, cloudCommandFailureFromCode, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";

export class CloudAgentExecutionError extends Error{
  readonly code: string;
  readonly failure: ReturnType<typeof cloudCommandFailureFromCode>;
  constructor(category: CloudCommandFailureCause["category"] = "authority_unavailable", stage: CloudCommandFailureCause["stage"] = "admission"){
    super("Cloud agent execution authority is unavailable");this.name="CloudAgentExecutionError";
    this.code=encodeCloudCommandFailure({stage,category});this.failure=cloudCommandFailureFromCode(this.code);
  }
}
export class CloudAgentAdmissionError extends Error {
  constructor(readonly code:CloudAgentAdmissionCode){super(code);this.name="CloudAgentAdmissionError";}
}
export class CloudRuntimeUpgradeRequiredError extends CloudAgentAdmissionError {
  constructor(){super("cloud_runtime_upgrade_required");this.name="CloudRuntimeUpgradeRequiredError";}
}
export class CloudComputerToolsUpdateRequiredError extends Error {
  constructor(){super("Update the cloud runtime and control plane to configure this computer.");this.name="CloudComputerToolsUpdateRequiredError";}
}
/** Same-origin fixed endpoint and bounded body; provider/driver errors never
 * cross the trusted-engine boundary with token or SQL data attached. */
export async function requestCloudAgentExecution(authority:CloudRuntimeAuthority,request:CloudAgentExecutionRequest,
  signal:AbortSignal,requestFetch:typeof fetch=fetch):Promise<unknown>{
  const {heartbeatEndpoint,heartbeatToken,...scope}=authority;
  const stage = request.kind === "admit" ? "admission" : "validation";
  let response:Response;
  try{
    const endpoint=new URL("/internal/v2/cloud-workspaces/engine/agent-execution",heartbeatEndpoint);
    if(endpoint.protocol!=="https:"&&!(endpoint.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)))throw new CloudAgentExecutionError("authority_unavailable",stage);
    response=await requestFetch(endpoint,{method:"POST",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]),
      headers:{"content-type":"application/json",authorization:`Bearer ${heartbeatToken}`},body:JSON.stringify({...scope,request})});
  }catch(error){
    if(error instanceof CloudAgentExecutionError)throw error;
    throw new CloudAgentExecutionError(error instanceof Error && error.name === "TimeoutError" ? "authority_timeout" : "authority_transport",stage);
  }
  const httpCategory = (): CloudCommandFailureCause["category"] => response.status === 429 ? "rate_limited" :
    response.status >= 500 ? "authority_http_5xx" : response.status >= 400 ? "authority_http_4xx" : "authority_unavailable";
  const invalidResponse = () => new CloudAgentExecutionError(response.ok ? "authority_response_invalid" : httpCategory(), stage);
  const typedConflict=response.status===409&&(request.kind==="computer-tool"||request.kind==="admit");
  const limit=response.ok?(request.kind==="terminal-environment"||(request.kind==="admit"&&request.environmentVersion===1)?2*1024*1024:request.kind==="computer-tool"?CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES:request.kind==="background"?256*1024:request.kind==="customization"||(request.kind==="admit"&&request.admission.customization)?1024*1024:40*1024):1024;
  if(!response.body||Number(response.headers.get("content-length"))>limit){await response.body?.cancel().catch(()=>{});throw invalidResponse();}
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit)throw invalidResponse();chunks.push(item.value);}
    let document:unknown;
    try { document=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))); }
    catch { if(response.status!==422) throw invalidResponse(); }
    if(!response.ok&&document&&typeof document==="object"&&!Array.isArray(document)&&Object.keys(document).join()==="error"){
      const cause=decodeCloudCommandFailure((document as {error?:unknown}).error);
      if(cause)throw new CloudAgentExecutionError(cause.category,cause.stage);
    }
    if(request.kind==="admit"&&response.status===409&&document&&typeof document==="object"&&
      Object.keys(document).join()==="error"&&(document as {error?:unknown}).error==="cloud_computer_tools_update_required")
      throw new CloudComputerToolsUpdateRequiredError();
    if((request.kind==="admit"||request.kind==="validate"||request.kind==="refresh-codex")&&response.status===409&&document&&typeof document==="object"&&
      Object.keys(document).join()==="error"&&isCloudAgentAdmissionCode((document as {error?:unknown}).error)) {
      const code=(document as {error:CloudAgentAdmissionCode}).error;
      throw code==="cloud_runtime_upgrade_required"?new CloudRuntimeUpgradeRequiredError():new CloudAgentAdmissionError(code);
    }
    // Only a definite, untyped schema rejection permits capability fallback.
    // A typed rejection keeps its authority cause and is never replayed.
    if(response.status===422&&request.kind==="admit"&&request.computerToolsVersion===1){
      const {computerToolsVersion:_version,...previous}=request;
      return requestCloudAgentExecution(authority,previous,signal,requestFetch);
    }
    if(response.status===422&&request.kind==="admit"&&request.backgroundTasksVersion===1){
      if(request.admission.customization)throw invalidResponse();
      return requestCloudAgentExecution(authority,{kind:"admit",admission:request.admission},signal,requestFetch);
    }
    if(!response.ok&&!typedConflict)throw invalidResponse();
    if(!document||typeof document!=="object"||Array.isArray(document)||Object.keys(document).join()!=="result")throw invalidResponse();
    const value=(document as {result:unknown}).result;
    if(request.kind==="computer-tool"){
      const parsed=response.status===409?CloudComputerToolConflictSchema.safeParse(value):CloudComputerToolResultSchemas[request.tool.name].safeParse(value);
      if(!parsed.success)throw invalidResponse();return parsed.data;
    }
    if(!response.ok)throw invalidResponse();
    if(request.kind==="terminal-environment"){
      const parsed=CloudComputerTerminalEnvironmentSchema.safeParse(value);if(!parsed.success)throw invalidResponse();return parsed.data;
    }
    if(request.kind==="background"){
      const parsed=CloudBackgroundStateSchema.safeParse(value);
      if(!parsed.success||parsed.data.leaseId!==request.leaseId||parsed.data.conversationId!==request.operation.conversationId)throw invalidResponse();
      return parsed.data;
    }
    if(request.kind==="customization"){
      const parsed=CloudCustomizationResultSchema.safeParse(value);if(!parsed.success)throw invalidResponse();return parsed.data;
    }
    if(request.kind==="admit"){
      const result=CloudAgentExecutionAuthoritySchema.safeParse(value);
      if(!result.success||result.data.provider!==request.admission.provider||result.data.model!==request.admission.model)throw invalidResponse();
      return result.data;
    }
    if(request.kind==="validate"||request.kind==="refresh-codex"){
      const result=CloudAgentExecutionLeaseSchema.safeParse(value);if(!result.success||result.data.leaseId!==request.leaseId)throw invalidResponse();return result.data;
    }
    if(request.kind==="authorize-action"){
      const result=CloudAgentActionAuthoritySchema.safeParse(value);
      if(!result.success||result.data.executionId!==request.executionId||result.data.actorSessionId!==request.actorSessionId)throw invalidResponse();
      return result.data;
    }
    if(!value||typeof value!=="object"||Object.keys(value).join()!=="released"||(value as {released?:unknown}).released!==true)throw invalidResponse();
    return {released:true};
  }catch(error){await reader.cancel().catch(()=>{});if((error instanceof CloudComputerToolsUpdateRequiredError)||(error instanceof CloudAgentAdmissionError)||(error instanceof CloudAgentExecutionError))throw error;
    throw error instanceof Error&&error.name==="TimeoutError"?new CloudAgentExecutionError("authority_timeout",stage):invalidResponse();}finally{reader.releaseLock();}
}
