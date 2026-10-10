import { isCloudAgentAdmissionCode, type CloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import {CloudAgentExecutionAuthoritySchema,CloudAgentExecutionLeaseSchema,CloudAgentActionAuthoritySchema,CloudBackgroundStateSchema,CloudComputerTerminalEnvironmentSchema,type CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import type {CloudRuntimeAuthority} from "./cloud-runtime-registration";
import { CloudCustomizationResultSchema } from "@zeros/protocol/cloud-customization";
import { CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES, CloudComputerToolConflictSchema, CloudComputerToolResultSchemas } from "@zeros/protocol/cloud-computer-tools";
import { encodeCloudCommandFailure, decodeCloudCommandFailure, cloudCommandFailureFromCode, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import {
  CloudAgentBootCredentialRequestSchema, CloudAgentBootCredentialResponseSchema,
  CloudAgentBootSyncRequestSchema, CloudAgentBootSyncResponseSchema,
  CloudAgentBootActivateRequestSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootRefreshRequestSchema, CloudAgentBootRefreshResponseSchema,
  CloudAgentActorConfirmRequestSchema, CloudAgentActorConfirmResponseSchema,
  CloudAgentWarmActorRequestSchema, CloudAgentWarmActorResponseSchema,
  type CloudAgentBootCredentialRequest, type CloudAgentBootCredentialResponse,
  type CloudAgentBootSyncRequest, type CloudAgentBootSyncResponse,
  type CloudAgentBootActivateRequest, type CloudAgentBootActivateResponse,
  type CloudAgentBootRefreshRequest, type CloudAgentBootRefreshResponse,
  type CloudAgentActorConfirmRequest, type CloudAgentActorConfirmResponse,
  type CloudAgentWarmActorRequest, type CloudAgentWarmActorResponse,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { isDeepStrictEqual } from "node:util";
import { cloudMcpDigest } from "./agents/cloud-mcp";

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

export type CloudAgentBootRequests = {
  bootstrap: CloudAgentBootCredentialRequest;
  sync: CloudAgentBootSyncRequest;
  activate: CloudAgentBootActivateRequest;
  refresh: CloudAgentBootRefreshRequest;
  "actor-confirm": CloudAgentActorConfirmRequest;
  "warm-context": CloudAgentWarmActorRequest;
};
export type CloudAgentBootResponses = {
  bootstrap: CloudAgentBootCredentialResponse;
  sync: CloudAgentBootSyncResponse;
  activate: CloudAgentBootActivateResponse;
  refresh: CloudAgentBootRefreshResponse;
  "actor-confirm": CloudAgentActorConfirmResponse;
  "warm-context": CloudAgentWarmActorResponse;
};
export type CloudAgentBootOperation = keyof CloudAgentBootRequests;
const bootContracts = {
  bootstrap: { request: CloudAgentBootCredentialRequestSchema, response: CloudAgentBootCredentialResponseSchema, limit: 256 * 1024 },
  sync: { request: CloudAgentBootSyncRequestSchema, response: CloudAgentBootSyncResponseSchema, limit: 256 * 1024 },
  activate: { request: CloudAgentBootActivateRequestSchema, response: CloudAgentBootActivateResponseSchema, limit: 8 * 1024 },
  refresh: { request: CloudAgentBootRefreshRequestSchema, response: CloudAgentBootRefreshResponseSchema, limit: 256 * 1024 },
  "actor-confirm": { request: CloudAgentActorConfirmRequestSchema, response: CloudAgentActorConfirmResponseSchema, limit: 8 * 1024 },
  "warm-context": { request: CloudAgentWarmActorRequestSchema, response: CloudAgentWarmActorResponseSchema, limit: 3 * 1024 * 1024 },
} as const;

/** Background-only boot/context transport. This API never negotiates a
 * legacy lease, retries a mutation, or accepts provider/actor selectors that
 * the private endpoint did not declare. A parsed response is still subject
 * to the cache/registry's monotonic authority and expiry checks. */
export async function requestCloudAgentBoot<Operation extends CloudAgentBootOperation>(
  authority: CloudRuntimeAuthority, operation: Operation, request: CloudAgentBootRequests[Operation],
  signal: AbortSignal, requestFetch: typeof fetch = fetch,
): Promise<CloudAgentBootResponses[Operation]> {
  const stage = operation === "bootstrap" || operation === "warm-context" ? "admission" : "validation";
  const failure = (category: CloudCommandFailureCause["category"]) => new CloudAgentExecutionError(category, stage);
  const contract = bootContracts[operation];
  const parsedRequest = contract?.request.safeParse(request);
  if (!parsedRequest?.success || ["organizationId", "workspaceId", "generation", "engineInstanceId"].some(key =>
    parsedRequest.data[key as keyof typeof parsedRequest.data] !== authority[key as keyof CloudRuntimeAuthority]))
    throw failure("authority_response_invalid");
  if (signal.aborted) throw failure("lifecycle_superseded");
  const body = JSON.stringify(parsedRequest.data);
  if (Buffer.byteLength(body) > (operation === "warm-context" ? 1024 * 1024 : 16 * 1024))
    throw failure("authority_response_invalid");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const transportFailure = (error: unknown) => failure(signal.aborted ? "lifecycle_superseded" :
    (error instanceof Error && error.name === "TimeoutError") ||
    (requestSignal.aborted && requestSignal.reason instanceof Error && requestSignal.reason.name === "TimeoutError")
      ? "authority_timeout" : "authority_transport");
  let response: Response;
  try {
    const origin = new URL(authority.heartbeatEndpoint);
    if (origin.username || origin.password || (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))))
      throw failure("authority_unavailable");
    const endpoint = new URL(`/internal/v2/cloud-workspaces/engine/agent-boot/${operation}`, origin);
    response = await requestFetch(endpoint, { method: "POST", redirect: "error", signal: requestSignal,
      headers: { "content-type": "application/json", authorization: `Bearer ${authority.heartbeatToken}` }, body });
  } catch (error) {
    if (error instanceof CloudAgentExecutionError) throw error;
    throw transportFailure(error);
  }
  const httpCategory = (): CloudCommandFailureCause["category"] => response.status === 429 ? "rate_limited" :
    response.status >= 500 ? "authority_http_5xx" : response.status >= 400 ? "authority_http_4xx" : "authority_unavailable";
  const invalidResponse = () => failure(response.ok ? "authority_response_invalid" : httpCategory());
  const limit = response.ok ? contract.limit : 1024;
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {}); throw invalidResponse();
  }
  const reader = response.body.getReader();
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw invalidResponse();
      chunks.push(item.value);
    }
    if (signal.aborted) throw failure("lifecycle_superseded");
    let document: unknown;
    try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw invalidResponse(); }
    if (!document || typeof document !== "object" || Array.isArray(document)) throw invalidResponse();
    if (!response.ok && Object.keys(document).join() === "error") {
      const code = (document as { error?: unknown }).error;
      const cause = decodeCloudCommandFailure(code);
      if (cause) throw new CloudAgentExecutionError(cause.category, cause.stage);
      if (isCloudAgentAdmissionCode(code))
        throw code === "cloud_runtime_upgrade_required" ? new CloudRuntimeUpgradeRequiredError() : new CloudAgentAdmissionError(code);
    }
    if (!response.ok || Object.keys(document).join() !== "result") throw invalidResponse();
    const result = contract.response.safeParse((document as { result: unknown }).result);
    if (!result.success) throw invalidResponse();
    const value = result.data;
    const bound = "provenance" in value ? value.provenance.scope : value;
    const requested = parsedRequest.data;
    if (["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"].some(key =>
      key in requested && requested[key as keyof typeof requested] !== bound[key as keyof typeof bound])) throw invalidResponse();
    if ("expectedCacheRevision" in requested && (typeof requested.expectedCacheRevision !== "number" ||
        !("cacheRevision" in value) || value.cacheRevision < requested.expectedCacheRevision))
      throw invalidResponse();
    if (operation === "refresh") {
      const expected = CloudAgentBootRefreshRequestSchema.parse(requested);
      const refreshed = CloudAgentBootRefreshResponseSchema.parse(value);
      if (refreshed.provider.credentialId !== expected.credentialId || refreshed.provider.credentialRevision !== expected.credentialRevision ||
          refreshed.provider.materialVersion <= expected.expectedMaterialVersion) throw invalidResponse();
    } else if (operation === "actor-confirm") {
      if (!("provenance" in value) || !("actorSessionId" in requested) || value.provenance.actorSessionId !== requested.actorSessionId)
        throw invalidResponse();
    } else if (operation === "warm-context") {
      const expected = CloudAgentWarmActorRequestSchema.parse(requested);
      const context = CloudAgentWarmActorResponseSchema.parse(value);
      if (context.actor.actorSessionId !== expected.actorSessionId || context.provider !== expected.provider || context.model !== expected.model ||
          context.conversationId !== expected.conversationId || context.cwd !== expected.cwd) throw invalidResponse();
      if (!isDeepStrictEqual(context.customization?.servers.filter(entry => entry.scope === "repository").map(entry => entry.server) ?? [], expected.repositoryServers))
        throw failure("customization_changed");
      if (context.customization) {
        const { digest, ...snapshot } = context.customization;
        if (digest !== cloudMcpDigest(snapshot)) throw invalidResponse();
      }
    }
    return value as CloudAgentBootResponses[Operation];
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CloudAgentExecutionError || error instanceof CloudAgentAdmissionError) throw error;
    throw transportFailure(error);
  } finally { reader.releaseLock(); }
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
    throw (error instanceof Error)&&error.name==="TimeoutError"?new CloudAgentExecutionError("authority_timeout",stage):invalidResponse();}finally{reader.releaseLock();}
}
