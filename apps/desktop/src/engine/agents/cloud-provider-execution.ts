import type {CloudAgentExecutionAdmission,CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { cloudCommandFailureCode, decodeCloudCommandFailure, CloudCommandFailureError, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import type {CloudAgentToolBridge} from "@zeros/protocol/cloud-agent-tools";
import {CLOUD_NATIVE_EXECUTION_PROFILE,cloudNativeProviderRestrictions,cloudBrowserUnavailable} from "@zeros/protocol/containment";
import {CloudAgentLease,type CloudAgentLeaseSupervisor,type CloudAuthorityFlightObservation,type CloudAuthorityRequestObservation} from "./cloud-agent-lease";
import {CloudWorkloadTools} from "./cloud-workload-tools";
import {CloudNativeBoundary} from "./containment/cloud-native-boundary";
import {assertCloudPreparedBoundaryLive} from "./containment/cloud-execution-boundary";
import {resolveCloudRuntime} from "./containment/cloud-runtime-root.mjs";
import type {PreparedBoundary} from "./containment/types";
import type {McpServerRegistration} from "./types";
import {materializeMcpServerRegistrations} from "./mcp-registration";
import { readCloudRepositoryMcp, cloudCodexMcpServer, freezeCloudSnapshot, type CloudRepositoryMcpNotice } from "./cloud-mcp";
import { CloudCustomizationRedactor } from "./cloud-customization-redaction";
import {CloudBackgroundExecution} from "./cloud-background-execution";
import {CloudComputerMcpServer} from "./cloud-computer-tools";
import {CLOUD_COMPUTER_TOOLS_SERVER} from "@zeros/protocol/cloud-computer-tools";
import {CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE} from "@zeros/protocol/system-instructions";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CloudAgentBootScopeSchema, CloudAgentWarmActorRequestSchema, CloudAgentWarmActorResponseSchema,
  type CloudAgentBootScope, type CloudAgentWarmActorRequest, type CloudAgentWarmActorResponse,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry, isCloudActorAuthorityRegistry, type CloudAuthorizedActor } from "./cloud-actor-authority";
import { cloudMcpDigest } from "./cloud-mcp";
import { CloudAgentCredentialCache, isCloudAgentCredentialCache, type CloudAgentCredentialCapture } from "./cloud-agent-credential-cache";
import { CloudAgentSessionLifetime } from "./cloud-agent-session-lifetime";
import type { CloudAgentCredentialRunInfo } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";

export type CloudLegacyAgentSelection=Omit<CloudAgentExecutionAdmission,"executionId"|"provider"|"customization">;
export type CloudAgentSelection=CloudLegacyAgentSelection|CloudBootAgentSelection;
/** Shared native lifetime/auth operations. Legacy implements these with its
 * real lease; boot mode implements them with a locally bounded session and
 * positive credential capture. No CP method is part of this interface. */
export type CloudAgentExecutionLifetime=Pick<CloudAgentLease,"signal"|"assertLive"|"launch"|"attach"|"retire"|"close">;
export type CloudAgentExecutionAuth=Pick<CloudAgentLease,"credentialVersion"|"codexAuth"|"refreshCodex">;
export type CloudExecutionMetadata={
  readonly provider:CloudAgentExecutionAdmission["provider"];
  readonly model:string;
  readonly credentialKind:CloudAgentLease["credentialKind"];
  readonly customization:CloudAgentLease["customization"];
  readonly nativeCapabilities:CloudAgentLease["nativeCapabilities"];
  readonly environment:CloudAgentLease["environment"];
  readonly gitAuthor:CloudAgentLease["gitAuthor"];
  readonly backgroundTasksVersion:1|null;
  readonly computerToolsVersion:1|null;
};
export type CloudLegacyProviderExecution=CloudExecutionMetadata&{
  readonly mode:"actor-grant-v1";
  readonly executionId:string;
  readonly conversationId:string;
  /** Trusted server-selected checkout root, never a renderer request cwd. */
  readonly cwd:string;
  readonly lease:CloudAgentLease;
  readonly lifetime:CloudAgentExecutionLifetime;
  readonly auth:CloudAgentExecutionAuth;
  readonly tools:CloudAgentToolBridge;
  readonly coordinator:CloudNativeBoundary;
  readonly background?:CloudBackgroundExecution;
  /** Only engine-minted product tools enter this snapshot, never user MCP. */
  readonly productServers:readonly McpServerRegistration[];
  readonly userServers?:readonly McpServerRegistration[];
  readonly redactor?:CloudCustomizationRedactor;
};
export type CloudProviderExecution=CloudLegacyProviderExecution|CloudBootProviderExecution;
const admitted=new WeakMap<PreparedBoundary,CloudProviderExecution>();
/** This identity is minted in trusted engine memory, never inferred from env,
 * an SDK message, a client flag, or a caller-supplied method implementation. */
export function cloudProviderExecution(boundary?:PreparedBoundary):CloudProviderExecution|null{
  return boundary?admitted.get(boundary)??null:null;
}
export function cloudExecutionLifetime(execution:CloudProviderExecution):CloudAgentExecutionLifetime{
  return execution.mode==="boot-owner-v1"?execution.lifetime:execution.lifetime??execution.lease;
}
/** Only CP-admitted computer tools identify the marked admin execution. */
export function adminWorkspaceSystemInstruction(boundary:PreparedBoundary|undefined,instruction?:string):string|undefined{
  return cloudProviderExecution(boundary)?.computerToolsVersion===1
    ? [instruction,CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE].filter(Boolean).join("\n\n") : instruction;
}
/** An execution uses its admitted snapshot, never the mutable Local registry. */
export function executionMcpServers(execution:CloudProviderExecution|null,registrations:readonly McpServerRegistration[]|undefined):McpServerRegistration[]|undefined{
  // A deep copy keeps the lease-scoped admitted snapshot immutable to callers.
  return execution?structuredClone([...(execution.productServers??[]),...(execution.userServers??[])]):registrations?[...registrations]:undefined;
}
export interface CloudAgentExecutionFactory {
  prepare(input:{admission:CloudAgentExecutionAdmission;conversationId:string;workload:PreparedBoundary;cwd:string;signal:AbortSignal;
    customization?:true;providerSettings?:Record<string,string>;productTools?:{servers:McpServerRegistration[];env:Record<string,string>}}):Promise<{
    boundary:PreparedBoundary;env:Record<string,string>;authorityId:string;
  }>;
}
export function createCloudAgentExecutionFactory(options:{
  request(request:CloudAgentExecutionRequest,signal:AbortSignal,observation?:CloudAuthorityRequestObservation):Promise<unknown>;
  supervisor:CloudAgentLeaseSupervisor;
  authorityObservation?:CloudAuthorityFlightObservation;
  onRepositoryMcpNotice?(context:{executionId:string;conversationId:string;provider:CloudAgentExecutionAdmission["provider"];notice:CloudRepositoryMcpNotice}):void;
}):CloudAgentExecutionFactory{
  return {async prepare({admission,conversationId,workload,cwd,signal,productTools,providerSettings,customization}){
    let lease:CloudAgentLease|undefined;
    let redactor:CloudCustomizationRedactor|undefined;
    let stage: CloudCommandFailureCause["stage"] = "validation";
    try{
      signal.throwIfAborted();
      if(resolveCloudRuntime().profile!=="v4")throw new Error("Cloud agents require a qualified v4 worker");
      const requested=customization?{...admission,customization:{version:3 as const,repositoryServers:await readCloudRepositoryMcp(cwd,admission.provider,notice=>
        options.onRepositoryMcpNotice?.({executionId:admission.executionId,conversationId,provider:admission.provider,notice}))}}:admission;
      stage = "admission";
      lease=await CloudAgentLease.admit(requested,options.request,signal,options.supervisor,undefined,options.authorityObservation);
      redactor=new CloudCustomizationRedactor([...Object.values(lease.environment?.values??{}),...(lease.customization?.servers??[]).flatMap(({server})=>
        Object.values(server.transport==="stdio"?server.env??{}:server.headers??{}))]);
      stage = "containment";
      lease.attach(workload);
      const coordinator=await CloudNativeBoundary.prepare(lease,workload,conversationId,providerSettings);
      const tools=new CloudWorkloadTools(lease,workload,cwd,coordinator.nativeHome);
      signal.throwIfAborted();
      lease.assertLive();
      const productServers=materializeMcpServerRegistrations(productTools?.servers??[],productTools?.env??{});
      if(productServers.some(server=>server.transport==="stdio"))throw new Error("Cloud product tools require a scoped remote transport");
      if(productServers.some(server=>server.name===CLOUD_COMPUTER_TOOLS_SERVER))throw new Error("Cloud Computer tools require private execution admission");
      if(lease.computerToolsVersion===1){
        const ownedLease=lease;
        const computer=await lease.launch(()=>CloudComputerMcpServer.start(ownedLease));
        productServers.push(computer.registration);
      }
      const userServers=lease.customization?.servers.map(({server,scope})=>{
        // Repository cwd is a compatible wire-relative projection. Translate
        // only after exact CP echo/digest verification, and only for repository
        // entries. Org/member absolute paths retain their original meaning.
        const materialized=scope==="repository"&&server.transport==="stdio"&&server.cwd?
          {...server,cwd:path.resolve(cwd,path.posix.relative("/srv/zeros/workspace",server.cwd))}:server;
        return admission.provider==="codex"?cloudCodexMcpServer(materialized):materialized;
      })??[];
      if(userServers.some(server=>productServers.some(product=>product.name===server.name)))throw new Error("Cloud MCP server name conflicts with a product tool");
      const owned=lease;
      const runtimeProfile="zeros-cloud-worker-v4" as const;
      // Gateway retirement closes both domains through the lease. This facade
      // is deliberately not attached back to the lease (which would deadlock).
      const boundary:PreparedBoundary={
        generation:workload.generation,status:{...coordinator.status,
          browser:{...cloudBrowserUnavailable(admission.provider,lease.credentialKind),runtimeProfile},
          parity:{level:"restricted",restrictions:[...new Set([...coordinator.status.parity.restrictions.filter(value=>!lease!.customization||value!=="user-mcp-disabled"),
            ...cloudNativeProviderRestrictions(admission.provider,lease.nativeCapabilities),...(!lease.customization?["user-mcp-disabled" as const]:[])])].sort()},cloudExecution:{version:1,
          profile:CLOUD_NATIVE_EXECUTION_PROFILE,runtimeProfile,provider:admission.provider,
          ...(lease.nativeCapabilities?{capabilities:{...lease.nativeCapabilities,connectedApps:lease.nativeCapabilities.connectedApps&&!!lease.codexAuth()}}:{}),
          designApi:productServers.some(server=>server.name==="design-draft"&&server.transport==="http")?"admitted":"unavailable"}},attestation:coordinator.attestation,
        providerHomePath:coordinator.providerHomePath,
        wrapSpawn:request=>coordinator.wrapSpawn(request),
        cancelUnstartedLaunch:launch=>coordinator.cancelUnstartedLaunch(launch),
        trackProcess:child=>coordinator.trackProcess(child),
        trackProcessGroup:()=>coordinator.trackProcessGroup(),
        spawn:request=>coordinator.spawn(request),
        requestPort:request=>coordinator.requestPort(request),
        activePorts:()=>workload.activePorts(),portDiscoveryStatus:()=>workload.portDiscoveryStatus(),
        onPortsChanged:listener=>workload.onPortsChanged(listener),
        revoke:()=>owned.close(),stopAndProve:()=>owned.close(),
      };
      redactor=coordinator.redactor??redactor;
      redactor.addSecrets(productServers.flatMap(server=>server.transport==="stdio"?[]:Object.values(server.headers??{})));
      const background=new CloudBackgroundExecution(lease,conversationId,()=>coordinator.hasBackgroundServers());
      admitted.set(boundary,Object.freeze({mode:"actor-grant-v1",executionId:admission.executionId,conversationId,
        cwd,lease,lifetime:lease,auth:lease,provider:admission.provider,model:admission.model,
        credentialKind:lease.credentialKind,customization:lease.customization,nativeCapabilities:lease.nativeCapabilities,
        environment:lease.environment,gitAuthor:lease.gitAuthor,backgroundTasksVersion:lease.backgroundTasksVersion,
        computerToolsVersion:lease.computerToolsVersion,tools,coordinator,background,
        productServers:freezeCloudSnapshot(structuredClone(productServers)),userServers:freezeCloudSnapshot(structuredClone(userServers)),redactor}));
      return {boundary,env:coordinator.environment(),authorityId:lease.authorityId};
    }catch(error){
      const redacted=redactor?.error(error)??error;
      const innerCode = redacted && typeof redacted === "object" && "code" in redacted ? redacted.code : undefined;
      const code = isCloudAgentAdmissionCode(innerCode)?innerCode:cloudCommandFailureCode(redacted, stage);
      try { if(lease)await lease.close();else await workload.stopAndProve(); }
      catch(retirementError){
        const retirementCode=cloudCommandFailureCode(retirementError,"containment");
        if(!lease)options.supervisor.onRetirementFailure(new CloudCommandFailureError(decodeCloudCommandFailure(retirementCode)!));
        // Retirement remains failed and retry/quarantine ownership stays live.
        // The original preparation cause is still the receipt's diagnosis.
        throw Object.assign(new AggregateError([redacted,new CloudCommandFailureError(decodeCloudCommandFailure(retirementCode)!)],
          redacted instanceof Error?redacted.message:"Cloud agent preparation failed"),{code});
      }
      if (isCloudAgentAdmissionCode(innerCode)) throw redacted;
      if (redacted instanceof Error) throw Object.assign(redacted, { code });
      throw new CloudCommandFailureError(decodeCloudCommandFailure(code)!);
    }
  }};
}

declare const authorizedAgentContext:unique symbol;
/** Nonsecret handle minted only after the private context response is bound
 * to this boot, checkout and exact current actor. Material stays in the
 * engine-owned record, outside renderer messages and native metadata. */
export interface CloudAuthorizedAgentContext{
  readonly [authorizedAgentContext]:true;
  readonly contextId:string;
  readonly contextRevision:string;
  readonly scope:CloudAgentBootScope;
  readonly actor:CloudAuthorizedActor;
  readonly provider:CloudAgentExecutionAdmission["provider"];
  readonly model:string;
  readonly conversationId:string;
  readonly cwd:string;
  readonly signal:AbortSignal;
  assertLive():void;
}
export type CloudAgentContextInput={
  actor:CloudAuthorizedActor; provider:CloudAgentExecutionAdmission["provider"];
  conversationId:string; model:string; cwd:string;
};
type ContextClock={wall():number;monotonic():number};
type AgentContextRecord={
  cache:CloudAgentContextCache;context:CloudAuthorizedAgentContext;key:string;controller:AbortController;
  response:CloudAgentWarmActorResponse|null;confirmedUntilMs:number;deadline:number;
  timer:ReturnType<typeof setTimeout>|null;cause:Error|null;notice?:CloudRepositoryMcpNotice;
};
const authorizedContexts=new WeakMap<object,AgentContextRecord>();
const contextCaches=new WeakMap<object,CloudActorAuthorityRegistry>();
export function isCloudAuthorizedAgentContext(value:unknown):value is CloudAuthorizedAgentContext{
  return !!value&&typeof value==="object"&&authorizedContexts.has(value);
}
function contextFailure(category:CloudCommandFailureCause["category"],stage:CloudCommandFailureCause["stage"]="validation"):Error{
  const failure=new CloudCommandFailureError({stage,category});
  return Object.assign(new Error("Cloud actor context is unavailable"),{code:failure.code});
}
function contextCause(error:unknown):Error{
  const code=error&&typeof error==="object"&&("code" in error)?error.code:undefined;
  if(isCloudAgentAdmissionCode(code)||decodeCloudCommandFailure(code))return Object.assign(new Error("Cloud actor context is unavailable"),{code});
  return contextFailure("authority_unavailable","admission");
}
function contextSnapshot(value:CloudAgentWarmActorResponse):unknown{
  const {actor,...snapshot}=value;
  const {confirmedUntilMs:_deadline,...provenance}=actor;
  return {...snapshot,actor:provenance};
}

/** Explicit background warming only. An actor-only renewal cannot extend
 * the MCP/environment/Git/history proof. Retired context IDs are retained as
 * bounded boot-long fences; expiry requires a genuinely new CP context ID.
 * Synchronous readiness/authorize never fetch or read repository files. */
export class CloudAgentContextCache{
  readonly scope:CloudAgentBootScope;
  private readonly time:ContextClock;
  private readonly controller=new AbortController();
  private readonly records=new Map<string,AgentContextRecord>();
  private readonly current=new Map<string,AgentContextRecord>();
  private readonly pending=new Map<string,Promise<CloudAuthorizedAgentContext>>();
  private readonly revoked=new Set<string>();
  private disposed=false;
  private readonly maxContexts:number;
  private readonly maxSeenContexts:number;
  constructor(private readonly options:{
    scope:CloudAgentBootScope;registry:CloudActorAuthorityRegistry;engineLive():boolean;
    /** Current engine-owned workspace/worktree admission, never a renderer list. */
    isAdmittedCwd(cwd:string,actor:CloudAuthorizedActor):boolean;
    request(request:CloudAgentWarmActorRequest,signal:AbortSignal):Promise<unknown>;
    time?:ContextClock;maxContexts?:number;maxSeenContexts?:number;
  }){
    const scope=CloudAgentBootScopeSchema.safeParse(options.scope);
    if(!scope.success||!isCloudActorAuthorityRegistry(options.registry)||!isDeepStrictEqual(scope.data,options.registry.scope)||
      (options.maxContexts!==undefined&&(!Number.isSafeInteger(options.maxContexts)||options.maxContexts<1||options.maxContexts>128))||
      (options.maxSeenContexts!==undefined&&(!Number.isSafeInteger(options.maxSeenContexts)||options.maxSeenContexts<1||options.maxSeenContexts>4096)))
      throw contextFailure("authority_response_invalid");
    this.scope=freezeCloudSnapshot(scope.data);this.time=options.time??{wall:()=>Date.now(),monotonic:()=>performance.now()};
    this.maxContexts=options.maxContexts??32;this.maxSeenContexts=options.maxSeenContexts??1024;
    contextCaches.set(this,options.registry);
  }
  private assertEngine():void{
    let live=false;
    try{live=!this.disposed&&this.options.engineLive();}catch{/* unavailable authority fails closed */}
    if(!live){this.dispose();throw contextFailure("lifecycle_superseded");}
  }
  private inputKey(input:CloudAgentContextInput):string{
    this.assertEngine();this.options.registry.assertActor(input.actor,"run");
    const {fundingOwnerUserId:_owner,fundingOwnerEpoch:_epoch,...reference}=this.scope;
    const parsed=CloudAgentWarmActorRequestSchema.safeParse({...reference,version:1,mode:"boot-owner-v1",
      actorSessionId:input.actor.provenance.actorSessionId,provider:input.provider,conversationId:input.conversationId,
      model:input.model,cwd:input.cwd,repositoryServers:[]});
    let admitted=false;
    try{admitted=parsed.success&&path.resolve(input.cwd)===input.cwd&&this.options.isAdmittedCwd(input.cwd,input.actor);}catch{/* refuses missing root authority */}
    if(!admitted)throw contextFailure("access_denied");
    const provenance=input.actor.provenance;
    return JSON.stringify([provenance.actorSessionId,provenance.authorityEpoch,provenance.actor,provenance.fundingGrant,
      input.provider,input.conversationId,input.model,input.cwd]);
  }
  private retire(record:AgentContextRecord,cause:Error):void{
    record.cause??=cause;record.response=null;
    if(record.timer){clearTimeout(record.timer);record.timer=null;}
    if(!record.controller.signal.aborted)record.controller.abort(record.cause);
  }
  private assertRecord(record:AgentContextRecord):void{
    this.assertEngine();
    if(record.cause)throw record.cause;
    try{
      this.options.registry.assertActor(record.context.actor,"run");
      if(this.time.wall()>=record.confirmedUntilMs||this.time.monotonic()>=record.deadline)throw contextFailure("session_expired");
      if(this.current.get(record.key)!==record||this.revoked.has(record.context.contextId))throw contextFailure("lifecycle_superseded");
      if(this.inputKey(record.context)!==record.key)throw contextFailure("access_denied");
    }catch(error){this.retire(record,contextCause(error));throw record.cause;}
  }
  private schedule(record:AgentContextRecord):void{
    if(record.timer)clearTimeout(record.timer);
    record.timer=setTimeout(()=>{record.timer=null;this.retire(record,contextFailure("session_expired"));},Math.max(0,record.deadline-this.time.monotonic()));
    record.timer.unref?.();
  }
  readiness(input:CloudAgentContextInput):{readonly state:"ready";readonly context:CloudAuthorizedAgentContext}|{readonly state:"pending"}{
    const key=this.inputKey(input),record=this.current.get(key);
    if(!record)return {state:"pending"};
    try{this.assertRecord(record);return {state:"ready",context:record.context};}catch{return {state:"pending"};}
  }
  authorize(input:CloudAgentContextInput):CloudAuthorizedAgentContext{
    const record=this.current.get(this.inputKey(input));
    if(!record)throw contextFailure("authority_unavailable");
    this.assertRecord(record);return record.context;
  }
  assertContext(context:CloudAuthorizedAgentContext):void{
    const record=authorizedContexts.get(context);
    if(!record||record.cache!==this)throw contextFailure("access_denied");
    this.assertRecord(record);
  }
  warm(input:CloudAgentContextInput,signal:AbortSignal=this.controller.signal):Promise<CloudAuthorizedAgentContext>{
    let key:string;
    try{key=this.inputKey(input);}catch(error){return Promise.reject(contextCause(error));}
    const pending=this.pending.get(key);if(pending)return pending;
    if(this.pending.size>=16)return Promise.reject(contextFailure("execution_limit"));
    const warming=(async()=>{
      const requestSignal=AbortSignal.any([signal,this.controller.signal,input.actor.signal]);
      if(requestSignal.aborted)throw contextFailure("lifecycle_superseded");
      let notice:CloudRepositoryMcpNotice|undefined;
      const repositoryServers=await readCloudRepositoryMcp(input.cwd,input.provider,value=>{notice=value;});
      this.inputKey(input);
      const {fundingOwnerUserId:_owner,fundingOwnerEpoch:_epoch,...reference}=this.scope;
      const request=CloudAgentWarmActorRequestSchema.parse({...reference,version:1,mode:"boot-owner-v1",
        actorSessionId:input.actor.provenance.actorSessionId,provider:input.provider,conversationId:input.conversationId,
        model:input.model,cwd:input.cwd,repositoryServers});
      const value=await this.options.request(request,requestSignal);
      this.assertEngine();
      if(requestSignal.aborted)throw contextFailure("lifecycle_superseded");
      const parsed=CloudAgentWarmActorResponseSchema.safeParse(value);
      if(!parsed.success||Object.entries(this.scope).some(([field,item])=>parsed.data[field as keyof typeof parsed.data]!==item)||
        parsed.data.actor.actorSessionId!==request.actorSessionId||parsed.data.provider!==request.provider||parsed.data.model!==request.model||
        parsed.data.cwd!==request.cwd||parsed.data.conversationId!==request.conversationId)
        throw contextFailure("authority_response_invalid","admission");
      const response=parsed.data;
      if(!isDeepStrictEqual(response.customization?.servers.filter(entry=>entry.scope==="repository").map(entry=>entry.server)??[],repositoryServers))
        throw contextFailure("customization_changed","admission");
      if(response.customization){
        const {digest,...snapshot}=response.customization;
        if(digest!==cloudMcpDigest(snapshot))throw contextFailure("authority_response_invalid","admission");
      }
      if(this.options.registry.confirm(response.actor)!==input.actor)throw contextFailure("lifecycle_superseded");
      this.inputKey(input);
      if(this.revoked.has(response.contextId))throw contextFailure("access_denied");
      const existing=this.records.get(response.contextId);
      if(existing){
        try{this.assertRecord(existing);}catch{throw contextFailure("lifecycle_superseded");}
        if(existing.key!==key||!existing.response||!isDeepStrictEqual(contextSnapshot(existing.response),contextSnapshot(response))){
          this.retire(existing,contextFailure("authority_response_invalid","admission"));throw existing.cause;
        }
        if(response.actor.confirmedUntilMs>existing.confirmedUntilMs){
          existing.confirmedUntilMs=response.actor.confirmedUntilMs;
          existing.deadline=this.time.monotonic()+existing.confirmedUntilMs-this.time.wall();
          existing.response=freezeCloudSnapshot(structuredClone(response));this.schedule(existing);
        }
        return existing.context;
      }
      const previous=this.current.get(key);
      const active=[...this.records.values()].filter(record=>!record.cause).length;
      if(active-(previous&&!previous.cause?1:0)>=this.maxContexts||this.records.size+this.revoked.size>=this.maxSeenContexts)
        throw contextFailure("execution_limit");
      const controller=new AbortController();let record:AgentContextRecord;
      const context=Object.freeze({contextId:response.contextId,contextRevision:response.contextRevision,scope:this.scope,
        actor:input.actor,provider:input.provider,model:input.model,conversationId:input.conversationId,cwd:input.cwd,
        signal:controller.signal,assertLive:()=>this.assertRecord(record)}) as CloudAuthorizedAgentContext;
      record={cache:this,context,key,controller,response:freezeCloudSnapshot(structuredClone(response)),notice,
        confirmedUntilMs:response.actor.confirmedUntilMs,deadline:this.time.monotonic()+response.actor.confirmedUntilMs-this.time.wall(),timer:null,cause:null};
      this.records.set(response.contextId,record);authorizedContexts.set(context,record);
      this.current.set(key,record);this.schedule(record);
      input.actor.signal.addEventListener("abort",()=>this.retire(record,contextCause(input.actor.signal.reason)),{once:true});
      if(previous)this.retire(previous,contextFailure("lifecycle_superseded"));
      this.assertRecord(record);return context;
    })().catch(error=>{throw contextCause(error);});
    this.pending.set(key,warming);
    void warming.finally(()=>{if(this.pending.get(key)===warming)this.pending.delete(key);}).catch(()=>{});
    return warming;
  }
  revokeContext(contextId:string):void{
    this.assertEngine();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contextId))throw contextFailure("authority_response_invalid");
    if(!this.revoked.has(contextId)&&this.revoked.size+this.records.size>=this.maxSeenContexts){this.dispose();throw contextFailure("execution_limit");}
    this.revoked.add(contextId);
    const record=this.records.get(contextId);if(record)this.retire(record,contextFailure("access_denied"));
  }
  dispose():void{
    this.disposed=true;this.controller.abort();
    for(const record of this.records.values())this.retire(record,contextFailure("lifecycle_superseded"));
  }
}

const bootSelection:unique symbol=Symbol("cloud-boot-selection");
const bootTurnReservation:unique symbol=Symbol("cloud-boot-turn-reservation");
export interface CloudBootAgentSelection extends CloudExecutionMetadata{
  readonly [bootSelection]:true;
  readonly mode:"boot-owner-v1";
  readonly scope:CloudAgentBootScope;
  readonly actor:CloudAuthorizedActor;
  readonly context:CloudAuthorizedAgentContext;
  readonly executionId:string;
  readonly conversationId:string;
  readonly cwd:string;
  readonly cacheRevision:number;
  readonly credentialRun:CloudAgentCredentialRunInfo;
}
/** This authority is minted with an original selection. It is not a lease:
 * there is no remote validate/release method or invented lease/delegation ID. */
export interface CloudBootNativeAuthority extends CloudExecutionMetadata{
  readonly mode:"boot-owner-v1";
  readonly scope:CloudAgentBootScope;
  readonly actor:CloudAuthorizedActor;
  readonly contextId:string;
  readonly executionId:string;
  readonly conversationId:string;
  readonly cwd:string;
  readonly lifetime:CloudAgentExecutionLifetime;
  readonly auth:CloudAgentExecutionAuth;
  takeMaterial():CloudAgentAccessMaterial;
}
export type CloudBootProviderExecution=CloudExecutionMetadata&{
  readonly mode:"boot-owner-v1";
  readonly scope:CloudAgentBootScope;
  readonly actor:CloudAuthorizedActor;
  readonly context:CloudAuthorizedAgentContext;
  readonly credentialRun:CloudAgentCredentialRunInfo;
  readonly executionId:string;
  readonly conversationId:string;
  readonly cwd:string;
  readonly lifetime:CloudAgentExecutionLifetime;
  readonly auth:CloudAgentExecutionAuth;
  readonly tools:CloudAgentToolBridge;
  readonly coordinator:CloudNativeBoundary;
  readonly productServers:readonly McpServerRegistration[];
  readonly userServers:readonly McpServerRegistration[];
  readonly redactor:CloudCustomizationRedactor;
  readonly background?:never;
};
export type CloudBootSelectionInput={
  readonly actor:CloudAuthorizedActor;readonly context:CloudAuthorizedAgentContext;
  readonly provider:CloudAgentExecutionAdmission["provider"];readonly model:string;
  readonly conversationId:string;readonly executionId:string;readonly cwd:string;
};
export type CloudBootSelectionExpected=Omit<CloudBootSelectionInput,"context">&{readonly cacheRevision:number};
export interface CloudBootTurnReservation{readonly [bootTurnReservation]:true}
export type CloudBootCredentialSelector={readonly provider:CloudAgentExecutionAdmission["provider"];readonly credentialId:string};
export type CloudBootDispatchReadiness=
  |{readonly state:"ready"|"pending";readonly cacheRevision:number;readonly desiredCacheRevision:number}
  |{readonly state:"unavailable";readonly code:string};
export type CloudBootScopeActivity={
  readonly complete:boolean;readonly foreground:number;readonly reservedLaunches:number;
  readonly background:number;readonly idleHosts:number;
  readonly scopes:readonly{readonly executionId:string;readonly conversationId:string;readonly commandId:string|null;
    readonly phase:"launch-reserved"|"foreground"|"background"|"idle";readonly credentialRun:CloudAgentCredentialRunInfo}[];
};
type BootPreparedExecution={boundary:PreparedBoundary;env:Record<string,string>;authorityId:string};
export interface CloudBootAgentExecutionFactory extends CloudAgentExecutionFactory{
  bootDispatchReadiness(input:CloudBootSelectionInput):CloudBootDispatchReadiness;
  selectBoot(input:CloudBootSelectionInput):CloudBootAgentSelection;
  assertBootStart(selection:CloudBootAgentSelection):void;
  validateBootSelection(value:unknown,expected:CloudBootSelectionExpected):CloudBootAgentSelection;
  launchBootSelection(selection:CloudBootAgentSelection,spawnWorkload:(signal:AbortSignal)=>Promise<PreparedBoundary>):Promise<PreparedBoundary>;
  prepareBoot(input:{selection:CloudBootAgentSelection;workload:PreparedBoundary;signal:AbortSignal;
    providerSettings?:Record<string,string>;productTools?:{servers:McpServerRegistration[];env:Record<string,string>}}):Promise<BootPreparedExecution>;
  canReuseBootExecution(execution:CloudProviderExecution,selection:CloudBootAgentSelection):boolean;
  /** Pure preclaim eligibility. It never reserves a turn or fetches authority. */
  canRetainBootExecution(input:CloudBootSelectionInput):boolean;
  reserveBootTurn(execution:CloudProviderExecution,selection:CloudBootAgentSelection):CloudBootTurnReservation;
  assertNativeHandoff(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):void;
  markNativeHandoff(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):void;
  /** Call after the original native turn is settled; preserves its owned host.
   * Engine settlement/history fences remain separate from this local lifetime. */
  settleBootTurn(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):Promise<void>;
  /** Periodic cleanup is separate from read-only idle census. Returned
   * identities remain original; this snapshot never reserves retirement. */
  idleBootExecutions():readonly CloudBootProviderExecution[];
  /** Atomically fence this exact eligible idle host before the first await.
   * A selected/reserved/entered next turn or retained background blocks it. */
  retireIdleBootExecution(execution:CloudProviderExecution):Promise<boolean>;
  bootScopeActivity(selectors:readonly CloudBootCredentialSelector[]):CloudBootScopeActivity;
  retireBootCredentials(selectors:readonly CloudBootCredentialSelector[]):Promise<void>;
  disposeBoot():Promise<void>;
}
type BootScopeRecord={
  factory:CloudBootAgentExecutionFactory;selection:CloudBootAgentSelection;capture:CloudAgentCredentialCapture;
  rawLifetime:CloudAgentSessionLifetime;lifetime:CloudAgentExecutionLifetime;authority:CloudBootNativeAuthority;
  phase:"launch-reserved"|"foreground"|"background"|"idle";
  workload:PreparedBoundary|null;execution:CloudBootProviderExecution|null;
  allocation:Promise<PreparedBoundary>|null;preparation:Promise<BootPreparedExecution>|null;
  reservation:BootTurnRecord|null;parent:BootScopeRecord|null;reuseOnly:BootScopeRecord|null;turnUsed:boolean;
  backgroundTurn:BootTurnRecord|null;
  closed:boolean;cause:Error|null;closing:Promise<void>|null;
  proved:boolean;detach():void;
};
type BootTurnRecord={
  public:CloudBootTurnReservation;owner:BootScopeRecord;selection:BootScopeRecord;entered:boolean;settled:boolean;retainsDescendants:boolean;
};
const bootFactories=new WeakSet<object>();
const bootSelections=new WeakMap<object,BootScopeRecord>();
const bootAuthorities=new WeakMap<object,BootScopeRecord>();
const bootExecutions=new WeakMap<object,BootScopeRecord>();
const bootTurns=new WeakMap<object,BootTurnRecord>();
export const isCloudBootAgentExecutionFactory=(value:unknown):value is CloudBootAgentExecutionFactory=>
  !!value&&typeof value==="object"&&bootFactories.has(value);
export const isCloudBootAgentSelection=(value:unknown):value is CloudBootAgentSelection=>
  !!value&&typeof value==="object"&&bootSelections.has(value);
export const isCloudBootNativeAuthority=(value:unknown):value is CloudBootNativeAuthority=>
  !!value&&typeof value==="object"&&bootAuthorities.has(value);
export const isCloudBootProviderExecution=(value:unknown):value is CloudBootProviderExecution=>
  !!value&&typeof value==="object"&&bootExecutions.has(value);
export function cloudBootNativeAuthority(selection:CloudBootAgentSelection):CloudBootNativeAuthority{
  const record=bootSelections.get(selection);
  if(!record)throw contextFailure("access_denied");
  record.lifetime.assertLive();return record.authority;
}
/** Native preparation accepts only the original authority and the exact
 * workload allocated by its factory, before exposing material or doing I/O. */
export function assertCloudBootNativePreparation(authority:CloudBootNativeAuthority,workload:PreparedBoundary,conversationId:string):void{
  const record=bootAuthorities.get(authority);
  if(!record||record.authority!==authority||record.workload!==workload||record.parent||record.reuseOnly||
    record.selection.conversationId!==conversationId)throw contextFailure("access_denied");
  record.factory.assertBootStart(record.selection);
}
/** New native allocation uses the current original selection. Descendants
 * of an already-entered turn keep that turn's bounded captured authority. */
export function assertCloudBootNativeLaunch(authority:CloudBootNativeAuthority):void{
  const record=bootAuthorities.get(authority);
  if(!record||record.authority!==authority||!record.workload)throw contextFailure("access_denied");
  record.lifetime.assertLive();
  const turn=record.reservation??record.backgroundTurn;
  if(turn?.entered&&(!turn.settled||turn.retainsDescendants))turn.selection.lifetime.assertLive();
  else record.factory.assertBootStart(turn?.selection.selection??record.selection);
}
/** Capture this original token before an adapter await; a later turn may
 * replace the active reservation on the same warm execution. */
export function cloudBootTurnReservation(execution:CloudProviderExecution):CloudBootTurnReservation|null{
  const record=bootExecutions.get(execution);return record?.reservation?.public??null;
}
export function assertCloudBootNativeHandoff(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):void{
  const record=bootExecutions.get(execution);if(!record)throw contextFailure("access_denied");
  record.factory.assertNativeHandoff(execution,reservation);
}
export function markCloudBootNativeHandoff(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):void{
  const record=bootExecutions.get(execution);if(!record)throw contextFailure("access_denied");
  record.factory.markNativeHandoff(execution,reservation);
}
export function assertCloudBootNativeContinuation(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):void{
  const owner=bootExecutions.get(execution),turn=bootTurns.get(reservation);
  if(!owner||!turn||turn.owner!==owner||owner.reservation!==turn||!turn.entered||turn.settled)throw contextFailure("access_denied");
  owner.lifetime.assertLive();turn.selection.lifetime.assertLive();
}

/** The engine invokes this only after negotiated CP boot initialization.
 * Helper-shaped objects cannot advertise mode, and Send performs no request.
 * Each selection reserves an exact bounded local owner before any allocation. */
export function createCloudBootAgentExecutionFactory(options:{
  legacy:CloudAgentExecutionFactory;credentials:CloudAgentCredentialCache;contexts:CloudAgentContextCache;
  registry:CloudActorAuthorityRegistry;engineLive():boolean;supervisor:CloudAgentLeaseSupervisor;
  /** W4's durable removal/pause fence. An exception is an authority refusal;
   * this is never an observational callback or a renderer-supplied boolean. */
  canStart(runInfo:CloudAgentCredentialRunInfo):boolean;
  maxScopes?:number;
  onRepositoryMcpNotice?(context:{executionId:string;conversationId:string;provider:CloudAgentExecutionAdmission["provider"];notice:CloudRepositoryMcpNotice}):void;
}):CloudBootAgentExecutionFactory{
  if(!isCloudAgentCredentialCache(options.credentials)||!isCloudActorAuthorityRegistry(options.registry)||
    contextCaches.get(options.contexts)!==options.registry||typeof options.legacy?.prepare!=="function"||typeof options.canStart!=="function"||
    !isDeepStrictEqual(options.credentials.scope,options.registry.scope)||!isDeepStrictEqual(options.contexts.scope,options.registry.scope)||
    (options.maxScopes!==undefined&&(!Number.isSafeInteger(options.maxScopes)||options.maxScopes<1||options.maxScopes>64)))
    throw contextFailure("authority_response_invalid");
  // The genuine constructor alone is insufficient: bootstrap must have
  // positively published its binding before this factory can be advertised.
  const scope=options.credentials.metadata;
  if(!isDeepStrictEqual(options.registry.scope,Object.fromEntries(Object.keys(options.registry.scope).map(key=>
    [key,scope[key as keyof typeof scope]]))))throw contextFailure("access_denied");
  const active=new Set<BootScopeRecord>(),seen=new Set<string>(),maxScopes=options.maxScopes??32;
  let disposed=false;
  let factory:CloudBootAgentExecutionFactory;
  const assertEngine=()=>{
    let live=false;try{live=!disposed&&options.engineLive();}catch{/* fail closed */}
    if(!live){void factory?.disposeBoot().catch(()=>{});throw contextFailure("lifecycle_superseded");}
    void options.credentials.metadata;
  };
  const original=(value:unknown):BootScopeRecord=>{
    const record=value&&typeof value==="object"?bootSelections.get(value):undefined;
    if(!record||record.factory!==factory)throw contextFailure("access_denied");
    return record;
  };
  const closeRecord=(record:BootScopeRecord,error:unknown=contextFailure("lifecycle_superseded")):Promise<void>=>{
    record.closed=true;record.cause??=contextCause(error);
    if(record.closing)return record.closing;
    const closing=(async()=>{
      // Waiting allocations and late attachments remain raw lifetime owners.
      // Material survives any failed proof; inventory cannot report zero.
      await record.rawLifetime.invalidate(record.cause);
      const children=[...active].filter(child=>child.parent===record);
      await Promise.all(children.map(child=>closeRecord(child,record.cause)));
      record.proved=true;record.detach();active.delete(record);
    })();
    record.closing=closing;
    void closing.finally(()=>{if(record.closing===closing)record.closing=null;}).catch(()=>{});
    return closing;
  };
  const assertRecord=(record:BootScopeRecord)=>{
    assertEngine();if(record.closed)throw record.cause??contextFailure("lifecycle_superseded");
    record.rawLifetime.assertLive();options.contexts.assertContext(record.selection.context);
  };
  const assertInput=(input:CloudBootSelectionInput)=>{
    assertEngine();options.registry.assertActor(input.actor,"run");options.contexts.assertContext(input.context);
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(input.executionId))throw contextFailure("access_denied");
  };
  const assertBinding=(input:CloudBootSelectionInput)=>{
    const context=input.context;
    if(context.actor!==input.actor||context.provider!==input.provider||context.model!==input.model||
      context.cwd!==input.cwd||context.conversationId!==input.conversationId)throw contextFailure("access_denied");
  };
  const executionRecord=(execution:CloudProviderExecution):BootScopeRecord=>{
    const record=bootExecutions.get(execution);
    if(!record||record.factory!==factory||record.execution!==execution)throw contextFailure("access_denied");
    assertRecord(record);return record;
  };
  const turnRecord=(execution:CloudProviderExecution,reservation:CloudBootTurnReservation):BootTurnRecord=>{
    const owner=executionRecord(execution),turn=bootTurns.get(reservation);
    if(!turn||turn.owner!==owner||owner.reservation!==turn||turn.settled)throw contextFailure("access_denied");
    assertRecord(turn.selection);return turn;
  };
  const validSelectors=(selectors:readonly CloudBootCredentialSelector[]):boolean=>Array.isArray(selectors)&&selectors.length<=32&&
    selectors.every(value=>value&&["claude","codex","cursor"].includes(value.provider)&&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.credentialId))&&
    new Set(selectors.map(value=>JSON.stringify([value.provider,value.credentialId]))).size===selectors.length;
  const matches=(record:BootScopeRecord,selectors:readonly CloudBootCredentialSelector[])=>!selectors.length||selectors.some(value=>
    record.capture.runInfo.provider===value.provider&&record.capture.runInfo.credentialId===value.credentialId);
  const idleEligible=(record:BootScopeRecord):boolean=>{
    if(record.closed||record.proved||record.parent||!record.execution||!record.workload||!record.turnUsed||
      record.phase!=="idle"||record.reservation||record.backgroundTurn||
      [...active].some(next=>next!==record&&!next.proved&&(next.reuseOnly===record||next.parent===record)))return false;
    try{assertRecord(record);assertCloudPreparedBoundaryLive(record.workload);return true;}
    catch{return false;}
  };
  factory={
    prepare:input=>options.legacy.prepare(input),
    bootDispatchReadiness(input){
      assertInput(input);
      const credential=options.credentials.readiness(input.provider,input.model);
      if(credential.state!=="ready")return credential;
      assertBinding(input);return credential;
    },
    selectBoot(input){
      const ready=factory.bootDispatchReadiness(input);
      if(ready.state==="pending")throw Object.assign(new Error("Cloud credentials are refreshing"),{code:"cloud_agent_credential_refresh_required"});
      if(ready.state==="unavailable")throw Object.assign(new Error("Cloud provider credentials are unavailable"),{code:ready.code});
      if(active.size>=maxScopes||(!seen.has(input.executionId)&&seen.size>=1024))throw contextFailure("execution_limit");
      const reuseOnly=seen.has(input.executionId)?[...active].find(record=>record.selection.executionId===input.executionId&&
        record.execution&&!record.parent&&!record.closed&&record.phase==="idle"&&!record.reservation)??null:null;
      if(seen.has(input.executionId)&&!reuseOnly)throw contextFailure("lifecycle_superseded");
      const context=authorizedContexts.get(input.context)!;
      const response=context.response!;
      const capture=options.credentials.capture(input.provider,input.model);
      let raw:CloudAgentSessionLifetime;
      try{raw=new CloudAgentSessionLifetime({actor:input.actor,credential:capture,engineLive:options.engineLive,supervisor:options.supervisor});}
      catch(error){capture.release();throw error;}
      const nativeCapabilities=Object.fromEntries(Object.entries(capture.nativeCapabilities).map(([key,value])=>
        [key,key==="version"?1:value===true&&response.nativeCapabilities[key as keyof typeof response.nativeCapabilities]===true])) as CloudAgentLease["nativeCapabilities"];
      const metadata:CloudExecutionMetadata={provider:input.provider,model:input.model,credentialKind:capture.credentialKind,
        customization:response.customization,nativeCapabilities:freezeCloudSnapshot(nativeCapabilities),environment:response.environment,
        gitAuthor:response.gitAuthor,backgroundTasksVersion:null,computerToolsVersion:null};
      // Private MCP/env/history material is read through non-enumerable native
      // properties. Selection JSON contains only bounded nonsecret identity.
      const {customization,environment,...publicMetadata}=metadata;
      const selection=Object.freeze(Object.defineProperties({[bootSelection]:true as const,...publicMetadata,mode:"boot-owner-v1" as const,
        scope:options.registry.scope,actor:input.actor,context:input.context,executionId:input.executionId,
        conversationId:input.conversationId,cwd:input.cwd,cacheRevision:capture.runInfo.cacheRevision,credentialRun:capture.runInfo},
        {customization:{value:customization},environment:{value:environment}})) as CloudBootAgentSelection;
      let record:BootScopeRecord;
      const lifetime:CloudAgentExecutionLifetime=Object.freeze({get signal(){return raw.signal;},assertLive:()=>assertRecord(record),
        launch:async<T extends {stopAndProve():Promise<void>}>(spawn:()=>Promise<T>)=>{assertRecord(record);return raw.launch(spawn);},
        attach:domain=>{raw.attach(domain);assertRecord(record);},retire:domain=>raw.retire(domain),close:()=>closeRecord(record)});
      const auth:CloudAgentExecutionAuth=Object.freeze({get credentialVersion(){return capture.credentialVersion;},
        codexAuth:()=>{assertRecord(record);return capture.codexAuth();},
        refreshCodex:async(version,previousAccountId)=>{assertRecord(record);return capture.refreshCodex(version,previousAccountId);}});
      const authority:CloudBootNativeAuthority=Object.freeze({...metadata,mode:"boot-owner-v1",scope:options.registry.scope,actor:input.actor,
        contextId:input.context.contextId,executionId:input.executionId,conversationId:input.conversationId,cwd:input.cwd,lifetime,auth,
        takeMaterial:()=>{assertRecord(record);return capture.takeMaterial();}});
      const ended=()=>{
        const cause=contextCause(input.context.signal.aborted?input.context.signal.reason:raw.signal.reason);
        record.closed=true;record.cause??=cause;
        // An entered follow-up's captured deadline governs its actual native
        // host and descendants. Ordinary successful capture release is inert
        // because settlement marks the original turn before closing the child.
        const parent=record.parent&&record.reservation?.entered&&(!record.reservation.settled||record.reservation.retainsDescendants)?record.parent:null;
        if(parent){parent.closed=true;parent.cause??=cause;}
        queueMicrotask(()=>{void closeRecord(parent??record,cause).catch(()=>{});});
      };
      const detach=()=>{raw.signal.removeEventListener("abort",ended);input.context.signal.removeEventListener("abort",ended);};
      record={factory,selection,capture,rawLifetime:raw,lifetime,authority,phase:"launch-reserved",workload:null,execution:null,
        allocation:null,preparation:null,reservation:null,parent:null,reuseOnly,turnUsed:false,backgroundTurn:null,
        closed:false,cause:null,closing:null,proved:false,detach};
      bootSelections.set(selection,record);bootAuthorities.set(authority,record);active.add(record);seen.add(input.executionId);
      raw.signal.addEventListener("abort",ended,{once:true});input.context.signal.addEventListener("abort",ended,{once:true});
      assertRecord(record);return selection;
    },
    assertBootStart(selection){
      const record=original(selection);assertRecord(record);
      options.credentials.assertCurrentSelection(record.capture,selection.model);
      let allowed=false;try{allowed=options.canStart(selection.credentialRun)===true;}catch{/* authority refusal */}
      if(!allowed)throw contextFailure("access_denied");
    },
    validateBootSelection(value,expected){
      const record=original(value);assertRecord(record);
      const selection=record.selection;
      if(selection.actor!==expected.actor||["provider","model","conversationId","executionId","cwd","cacheRevision"].some(field=>
        selection[field as keyof CloudBootSelectionExpected]!==expected[field as keyof CloudBootSelectionExpected]))throw contextFailure("access_denied");
      return selection;
    },
    launchBootSelection(selection,spawnWorkload){
      const record=original(selection);factory.assertBootStart(selection);
      if(record.allocation||record.workload||record.parent||record.reuseOnly)throw contextFailure("access_denied");
      const allocation=record.lifetime.launch(()=>{
        factory.assertBootStart(selection);
        return spawnWorkload(record.lifetime.signal);
      }).then(domain=>{
        record.workload=domain;assertCloudPreparedBoundaryLive(domain);return domain;
      }).catch(async error=>{await closeRecord(record);throw contextCause(error);});
      record.allocation=allocation;
      return allocation;
    },
    prepareBoot({selection,workload,signal,providerSettings,productTools}){
      const record=original(selection);
      if(record.preparation||record.workload!==workload||record.parent)return Promise.reject(contextFailure("access_denied"));
      const preparing=(async()=>{
        let redactor:CloudCustomizationRedactor|undefined;
        try{
          if(signal.aborted)throw contextFailure("lifecycle_superseded");
          factory.assertBootStart(selection);
          if(resolveCloudRuntime().profile!=="v4")throw contextFailure("environment_runtime_required","containment");
          const coordinator=await record.lifetime.launch(()=>CloudNativeBoundary.prepareBoot(record.authority,workload,selection.conversationId,providerSettings));
          const tools=new CloudWorkloadTools(record.authority,workload,selection.cwd,coordinator.nativeHome);
          if(signal.aborted)throw contextFailure("lifecycle_superseded");
          factory.assertBootStart(selection);
          const productServers=materializeMcpServerRegistrations(productTools?.servers??[],productTools?.env??{});
          if(productServers.some(server=>server.transport==="stdio"||server.name===CLOUD_COMPUTER_TOOLS_SERVER))throw contextFailure("access_denied");
          const userServers=selection.customization?.servers.map(({server,scope})=>{
            const materialized=scope==="repository"&&server.transport==="stdio"&&server.cwd?
              {...server,cwd:path.resolve(selection.cwd,path.posix.relative("/srv/zeros/workspace",server.cwd))}:server;
            return selection.provider==="codex"?cloudCodexMcpServer(materialized):materialized;
          })??[];
          if(userServers.some(server=>productServers.some(product=>product.name===server.name)))throw contextFailure("access_denied");
          redactor=coordinator.redactor??new CloudCustomizationRedactor([...Object.values(selection.environment?.values??{}),
            ...(selection.customization?.servers??[]).flatMap(({server})=>Object.values(server.transport==="stdio"?server.env??{}:server.headers??{}))]);
          redactor.addSecrets(productServers.flatMap(server=>server.transport==="stdio"?[]:Object.values(server.headers??{})));
          const runtimeProfile="zeros-cloud-worker-v4" as const;
          const boundary:PreparedBoundary={generation:workload.generation,status:{...coordinator.status,
            browser:{...cloudBrowserUnavailable(selection.provider,selection.credentialKind),runtimeProfile},
            parity:{level:"restricted",restrictions:[...new Set([...coordinator.status.parity.restrictions.filter(value=>!selection.customization||value!=="user-mcp-disabled"),
              ...cloudNativeProviderRestrictions(selection.provider,selection.nativeCapabilities),...(!selection.customization?["user-mcp-disabled" as const]:[])])].sort()},
            cloudExecution:{version:1,profile:CLOUD_NATIVE_EXECUTION_PROFILE,runtimeProfile,provider:selection.provider,
              ...(selection.nativeCapabilities?{capabilities:{...selection.nativeCapabilities,connectedApps:selection.nativeCapabilities.connectedApps&&!!record.authority.auth.codexAuth()}}:{}),
              designApi:productServers.some(server=>server.name==="design-draft"&&server.transport==="http")?"admitted":"unavailable"}},attestation:coordinator.attestation,
            providerHomePath:coordinator.providerHomePath,wrapSpawn:request=>coordinator.wrapSpawn(request),
            cancelUnstartedLaunch:launch=>coordinator.cancelUnstartedLaunch(launch),trackProcess:child=>coordinator.trackProcess(child),
            trackProcessGroup:()=>coordinator.trackProcessGroup(),spawn:request=>coordinator.spawn(request),requestPort:request=>coordinator.requestPort(request),
            activePorts:()=>workload.activePorts(),portDiscoveryStatus:()=>workload.portDiscoveryStatus(),onPortsChanged:listener=>workload.onPortsChanged(listener),
            revoke:()=>record.lifetime.close(),stopAndProve:()=>record.lifetime.close()};
          const execution:CloudBootProviderExecution=Object.freeze({mode:"boot-owner-v1",scope:selection.scope,actor:selection.actor,context:selection.context,
            credentialRun:selection.credentialRun,executionId:selection.executionId,conversationId:selection.conversationId,cwd:selection.cwd,
            provider:selection.provider,model:selection.model,credentialKind:selection.credentialKind,customization:selection.customization,
            nativeCapabilities:selection.nativeCapabilities,environment:selection.environment,gitAuthor:selection.gitAuthor,
            backgroundTasksVersion:null,computerToolsVersion:null,lifetime:record.lifetime,auth:record.authority.auth,tools,coordinator,
            productServers:freezeCloudSnapshot(structuredClone(productServers)),userServers:freezeCloudSnapshot(structuredClone(userServers)),redactor});
          record.execution=execution;record.phase="idle";admitted.set(boundary,execution);bootExecutions.set(execution,record);
          const notice=authorizedContexts.get(selection.context)?.notice;
          if(notice){try{const result=options.onRepositoryMcpNotice?.({executionId:selection.executionId,conversationId:selection.conversationId,provider:selection.provider,notice});
            void Promise.resolve(result).catch(()=>{});}catch{/* nonfatal bounded notice */}}
          return {boundary,env:coordinator.environment(),authorityId:selection.context.contextRevision};
        }catch(error){
          const cause=redactor?.error(error)??error;
          try{await closeRecord(record);}catch(retirementError){throw Object.assign(new AggregateError([contextCause(cause),contextCause(retirementError)],
            "Cloud native preparation failed"),{code:cloudCommandFailureCode(cause,"containment")});}
          throw Object.assign(new Error("Cloud native preparation failed"),{code:cloudCommandFailureCode(cause,"containment")});
        }
      })();
      record.preparation=preparing;return preparing;
    },
    canRetainBootExecution(input){
      let capture:CloudAgentCredentialCapture|undefined;
      try{
        assertInput(input);assertBinding(input);
        if(options.credentials.readiness(input.provider,input.model).state!=="ready")return false;
        const owner=[...active].find(record=>record.selection.executionId===input.executionId&&record.execution&&!record.parent);
        if(!owner||owner.closed||owner.phase!=="idle"||owner.reservation||owner.backgroundTurn)return false;
        assertRecord(owner);
        assertCloudPreparedBoundaryLive(owner.workload!);
        if(owner.selection.actor!==input.actor||owner.selection.context!==input.context||owner.selection.provider!==input.provider||
          owner.selection.model!==input.model||owner.selection.cwd!==input.cwd||owner.selection.conversationId!==input.conversationId)return false;
        capture=options.credentials.capture(input.provider,input.model);
        options.credentials.assertCurrentSelection(capture,input.model);
        if(options.canStart(capture.runInfo)!==true)return false;
        return owner.capture.runInfo.credentialId===capture.runInfo.credentialId&&
          isDeepStrictEqual(owner.capture.nativeCapabilities,capture.nativeCapabilities)&&isDeepStrictEqual(owner.capture.models,capture.models)&&
          options.credentials.sameAuthScope(owner.capture,capture);
      }catch{return false;}
      finally{capture?.release();}
    },
    canReuseBootExecution(execution,selection){
      try{
        const owner=executionRecord(execution),next=original(selection);factory.assertBootStart(selection);
        assertCloudPreparedBoundaryLive(owner.workload!);
        if(owner.reservation||owner.phase!=="idle"||next.parent||next.workload||next.execution)return false;
        return owner.selection.executionId===selection.executionId&&next.reuseOnly===owner&&
          owner.selection.actor===selection.actor&&owner.selection.context===selection.context&&
          owner.selection.provider===selection.provider&&owner.selection.model===selection.model&&owner.selection.cwd===selection.cwd&&
          owner.selection.conversationId===selection.conversationId&&owner.capture.runInfo.credentialId===next.capture.runInfo.credentialId&&
          isDeepStrictEqual(owner.capture.nativeCapabilities,next.capture.nativeCapabilities)&&isDeepStrictEqual(owner.capture.models,next.capture.models)&&
          options.credentials.sameAuthScope(owner.capture,next.capture);
      }catch{return false;}
    },
    reserveBootTurn(execution,selection){
      const owner=executionRecord(execution),next=original(selection);factory.assertBootStart(selection);
      assertCloudPreparedBoundaryLive(owner.workload!);
      if(owner.reservation||next.reservation||next.parent||next.turnUsed||
        (owner!==next&&!factory.canReuseBootExecution(execution,selection)))throw contextFailure("access_denied");
      next.turnUsed=true;
      if(owner!==next)next.parent=owner;
      const publicReservation=Object.freeze({[bootTurnReservation]:true as const});
      const turn:BootTurnRecord={public:publicReservation,owner,selection:next,entered:false,settled:false,retainsDescendants:false};
      owner.reservation=turn;next.reservation=turn;bootTurns.set(publicReservation,turn);return publicReservation;
    },
    assertNativeHandoff(execution,reservation){
      const turn=turnRecord(execution,reservation);
      if(turn.entered)throw contextFailure("access_denied");
      factory.assertBootStart(turn.selection.selection);
      assertCloudPreparedBoundaryLive(turn.owner.workload!);
    },
    markNativeHandoff(execution,reservation){
      factory.assertNativeHandoff(execution,reservation);
      const turn=turnRecord(execution,reservation);turn.entered=true;turn.owner.phase="foreground";turn.selection.phase="foreground";
    },
    async settleBootTurn(execution,reservation){
      const turn=turnRecord(execution,reservation);if(!turn.entered)throw contextFailure("access_denied");
      const background=await execution.coordinator.hasBackgroundServers();
      turnRecord(execution,reservation);
      turn.settled=true;turn.owner.reservation=null;turn.owner.phase=background?"background":"idle";
      turn.retainsDescendants=background;
      if(background){
        // Native descendants still carry this turn's source, deadline and
        // provenance. Keep its capture until exact whole-scope retirement;
        // a terminal foreground result is not an empty descendant proof.
        turn.owner.backgroundTurn=turn;turn.selection.phase="background";
      }else if(turn.selection!==turn.owner){turn.selection.reservation=null;await closeRecord(turn.selection);}
    },
    idleBootExecutions(){
      assertEngine();
      return Object.freeze([...active].filter(idleEligible).map(record=>record.execution!));
    },
    retireIdleBootExecution(execution){
      const record=bootExecutions.get(execution);
      if(!record||record.factory!==factory||record.execution!==execution)return Promise.reject(contextFailure("access_denied"));
      if(!idleEligible(record))return Promise.resolve(false);
      // closeRecord sets closed and aborts its original lifetime synchronously.
      // A concurrent next selection cannot revive or reserve this old host.
      // Failed positive group proof propagates and remains in the inventory.
      return closeRecord(record).then(()=>true);
    },
    bootScopeActivity(selectors){
      if(!validSelectors(selectors))return {complete:false,foreground:0,reservedLaunches:0,background:0,idleHosts:0,scopes:[]};
      const scopes=[...active].filter(record=>matches(record,selectors)&&!record.proved&&
        !(record.parent&&record.reservation?.entered)).map(record=>({executionId:record.selection.executionId,
          conversationId:record.selection.conversationId,commandId:null,phase:record.reservation&&!record.reservation.entered?"launch-reserved" as const:record.phase,
          credentialRun:record.reservation?.selection.capture.runInfo??record.backgroundTurn?.selection.capture.runInfo??record.capture.runInfo}));
      return freezeCloudSnapshot({complete:true,foreground:scopes.filter(value=>value.phase==="foreground").length,
        reservedLaunches:scopes.filter(value=>value.phase==="launch-reserved").length,
        background:scopes.filter(value=>value.phase==="background").length,idleHosts:scopes.filter(value=>value.phase==="idle").length,scopes});
    },
    retireBootCredentials(selectors){
      if(!validSelectors(selectors)||!selectors.length)return Promise.reject(contextFailure("authority_response_invalid"));
      // Source invalidation and late publication fences happen synchronously
      // before the first await, including idle and superseded captured runs.
      for(const value of selectors)options.credentials.retireAssociation(value.provider,value.credentialId);
      return Promise.all([...active].filter(record=>matches(record,selectors)).map(record=>closeRecord(record))).then(()=>{});
    },
    disposeBoot(){
      disposed=true;options.credentials.dispose();
      return Promise.all([...active].map(record=>closeRecord(record))).then(()=>{});
    },
  };
  assertEngine();Object.freeze(factory);bootFactories.add(factory);return factory;
}
