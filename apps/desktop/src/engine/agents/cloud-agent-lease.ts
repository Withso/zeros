import {
  CloudAgentExecutionAuthoritySchema,
  CloudAgentExecutionLeaseSchema,
  CloudBackgroundStateSchema,
  type CloudBackgroundOperation,
  type CloudGitAuthor,
  type CloudAgentAccessMaterial,
  type CloudAgentExecutionAdmission,
  type CloudAgentExecutionRequest,
  type CloudNativeCapabilities,
  type CloudComputerExecutionEnvironment,
  isCloudAgentAdmissionCode,
} from "@zeros/protocol/cloud-agent-execution";
import { encodeCloudCommandFailure, decodeCloudCommandFailure, cloudCommandFailureFromCode, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import type { CloudCustomizationSnapshot } from "@zeros/protocol/cloud-customization";
import { cloudMcpDigest, freezeCloudSnapshot } from "./cloud-mcp";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { CloudComputerToolConflictSchema, CloudComputerToolExecutionRequestSchema, CloudComputerToolResultSchemas, type CloudComputerToolRequest } from "@zeros/protocol/cloud-computer-tools";
export { CloudActorAuthorityRegistry, isCloudAuthorizedActor, type CloudAuthorizedActor } from "./cloud-actor-authority";

export type CloudAuthorityOperation = "validate" | "renew" | "refresh-codex" | "cache-publication";
export type CloudAuthorityConsumer = "validate" | "refresh-codex" | "dispatch-ready";
export type CloudAuthorityOrigin = "caller" | "scheduled";
/** Passive engine observations. They grant no authority and carry no native
 * payload. Producer origin and each caller's actual dependency are separate. */
export type CloudAuthorityFlightObservation = {
  created(event: { flightId: string; operation: CloudAuthorityOperation; producer: CloudAuthorityOrigin }): void;
  wait(event: { waitId: string; flightId: string | null; consumer: CloudAuthorityConsumer; phase: "waiting" | "unblocked" }): void;
  settled(event: { flightId: string; outcome: "settled" | "failed" }): void;
};
/** Internal callback metadata only: never part of the strict request JSON. */
export type CloudAuthorityRequestObservation = { flightId: string };
type Request = (request: CloudAgentExecutionRequest, signal: AbortSignal, observation?: CloudAuthorityRequestObservation) => Promise<unknown>;
type Clock = { wall(): number; monotonic(): number };
type ProcessDomain = { stopAndProve(): Promise<void> };
export type CloudAgentLeaseSupervisor = {
  /** Must quarantine/terminate the worker, not merely log the error. */
  onRetirementFailure(error: Error): void;
};
const clock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
function leaseFailure(category:CloudCommandFailureCause["category"],message="Cloud agent authority changed",stage:CloudCommandFailureCause["stage"]="validation"){
  const code=encodeCloudCommandFailure({stage,category});
  return Object.assign(new Error(message),{code,failure:cloudCommandFailureFromCode(code)});
}
/** Preserve only closed authority metadata. Raw driver/provider diagnostics
 * must not become a user-facing error when a lease retires. */
function safeLeaseFailure(error:unknown,category:CloudCommandFailureCause["category"]="authority_unavailable",message="Cloud agent authority changed",stage:CloudCommandFailureCause["stage"]="validation"){
  const code=error&&typeof error==="object"&&"code" in error?error.code:undefined;
  if(decodeCloudCommandFailure(code)||isCloudAgentAdmissionCode(code))
    return Object.assign(new Error(message),{code:code as string,failure:cloudCommandFailureFromCode(code)});
  return leaseFailure(category,message,stage);
}

/** Owns coordinator and workload lifetime. Admission cancellation is separate
 * from execution Stop: an ordinary device disconnect does not stop committed work. */
export class CloudAgentLease {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private retired = false;
  private retirementCause:Error|null=null;
  private released = false;
  private retirementFailures = 0;
  private escalated = false;
  private closing: Promise<void> | null = null;
  private renewing: Promise<void> | null = null;
  private readonly domains = new Set<ProcessDomain>();
  private readonly stopping = new Map<ProcessDomain, Promise<void>>();
  private readonly launches = new Set<Promise<ProcessDomain>>();
  private material: CloudAgentAccessMaterial | null;
  /** Safe diagnostic category retained after the one-shot material is consumed. */
  readonly credentialKind: CloudAgentAccessMaterial["kind"];
  private codexMaterial: Extract<CloudAgentAccessMaterial,{kind:"codex-chatgpt"}> | null;
  private materialVersion: number;
  private validationTail: Promise<unknown> = Promise.resolve();
  private validationTailFlight: string | null = null;
  private readonly validationFlights = new WeakMap<Promise<void>, string>();
  private pendingValidations = 0;
  private backgroundDeadline = Infinity;
  private constructor(
    readonly leaseId: string, readonly authorityId: string, credentialVersion: number,
    readonly admission: CloudAgentExecutionAdmission, material: CloudAgentAccessMaterial,
    private readonly request: Request, private readonly supervisor: CloudAgentLeaseSupervisor,
    private readonly time: Clock,
    readonly gitAuthor: CloudGitAuthor | null,
    readonly customization: CloudCustomizationSnapshot | null,
    readonly nativeCapabilities: Readonly<CloudNativeCapabilities> | null,
    readonly backgroundTasksVersion: 1 | null,
    readonly computerToolsVersion: 1 | null,
    readonly environment: CloudComputerExecutionEnvironment | null,
    private readonly observation?: CloudAuthorityFlightObservation,
  ) { this.credentialKind = material.kind; this.material = material; this.materialVersion = credentialVersion; this.codexMaterial = material.kind === "codex-chatgpt" ? {...material} : null; }

  static async admit(
    admission: CloudAgentExecutionAdmission, request: Request, signal: AbortSignal,
    supervisor: CloudAgentLeaseSupervisor, time: Clock = clock,
    observation?: CloudAuthorityFlightObservation,
  ): Promise<CloudAgentLease> {
    const start = time.monotonic();
    let raw:unknown;
    try{raw=await request({ kind: "admit", admission, includeGitAuthor: true,nativeCapabilitiesVersion:1,backgroundTasksVersion:1,computerToolsVersion:1,environmentVersion:1 }, signal);}
    catch(error){throw safeLeaseFailure(error,"authority_unavailable","Cloud agent admission failed","admission");}
    const response = CloudAgentExecutionAuthoritySchema.safeParse(raw);
    if (!response.success || response.data.provider !== admission.provider || response.data.model !== admission.model)
      throw leaseFailure("authority_response_invalid","Cloud agent admission failed","admission");
    const value = response.data;
    if (admission.customization && !value.customization && admission.customization.version !== 3)
      throw leaseFailure("customization_changed","Cloud customization admission is unavailable. Update the cloud runtime and control plane.","admission");
    if (admission.customization && value.customization) {
      if (!isDeepStrictEqual(value.customization.servers.filter(entry => entry.scope === "repository").map(entry => entry.server), admission.customization.repositoryServers))
        throw leaseFailure("customization_changed","Cloud customization admission is unavailable. Update the cloud runtime and control plane.","admission");
      const { digest, ...snapshot } = value.customization;
      if (digest !== cloudMcpDigest(snapshot)) throw leaseFailure("authority_response_invalid","Cloud customization admission is invalid","admission");
    }
    const lease = new CloudAgentLease(value.leaseId, value.authorityId, value.credentialVersion,
      freezeCloudSnapshot(structuredClone(admission)), value.material, request, supervisor, time, value.gitAuthor ? Object.freeze({ ...value.gitAuthor }) : null,
      value.customization ? freezeCloudSnapshot(value.customization) : null,
      value.nativeCapabilities ? Object.freeze({...value.nativeCapabilities}) : null,value.backgroundTasksVersion??null,value.computerToolsVersion??null,
      value.environment ? freezeCloudSnapshot(value.environment) : null, observation);
    try {
      lease.acceptExpiry(value.expiresAt, start,"admission");
      if (signal.aborted) throw new Error("Cloud agent admission cancelled");
      lease.schedule();
      return lease;
    } catch (error) { const failure=safeLeaseFailure(error,"authority_response_invalid","Cloud agent admission failed","admission");lease.retirementCause=failure;await lease.close().catch(() => {});throw failure; }
  }
  get signal(): AbortSignal { return this.controller.signal; }
  get credentialVersion(): number { return this.materialVersion; }
  codexAuth(): {material:Extract<CloudAgentAccessMaterial,{kind:"codex-chatgpt"}>;credentialVersion:number}|null {
    this.assertLive();return this.codexMaterial?{material:{...this.codexMaterial},credentialVersion:this.materialVersion}:null;
  }
  async refreshCodex(credentialVersion:number,previousAccountId?:string|null){
    this.assertLive();
    if(!this.codexMaterial||!Number.isSafeInteger(credentialVersion)||credentialVersion<1||credentialVersion>this.materialVersion||
      (previousAccountId!=null&&previousAccountId!==this.codexMaterial.accountId)){
      const failure=leaseFailure("credential_refresh_invalid");this.retirementCause??=failure;void this.close().catch(()=>{});throw failure;
    }
    const operation = this.check(true, credentialVersion);
    await this.observeWait(operation, this.validationFlights.get(operation) ?? null, "refresh-codex");
    this.assertLive();const current=this.codexAuth();
    if(!current||current.credentialVersion<=credentialVersion)throw leaseFailure("credential_refresh_unchanged");
    return current;
  }
  takeMaterial(): CloudAgentAccessMaterial {
    this.assertLive();
    if (!this.material) throw new Error("Cloud agent material was already consumed");
    const material = this.material; this.material = null; return material;
  }
  /** Reserve cleanup ownership BEFORE starting any asynchronous spawn. */
  async launch<T extends ProcessDomain>(spawn: () => Promise<T>): Promise<T> {
    this.assertLive();
    const pending = Promise.resolve().then(() => { this.assertLive(); return spawn(); });
    this.launches.add(pending);
    try { const domain = await pending; this.attach(domain); return domain; }
    finally { this.launches.delete(pending); }
  }
  attach(domain: ProcessDomain): void {
    this.domains.add(domain);
    if (this.retired) {
      // Even if close is awaiting the CP, take immediate ownership of this child.
      void this.stopDomain(domain).catch(error => this.queueRetirement(error));
      void this.close().catch(() => {});
      throw this.retirementCause??leaseFailure("lifecycle_superseded","Cloud agent lease is retired");
    }
  }
  /** Release a short-lived child only after proof; keep execution ownership
   * bounded during long sessions with thousands of tool calls. */
  async retire(domain: ProcessDomain): Promise<void> {
    try { await this.stopDomain(domain); }
    catch (error) { void this.close().catch(() => {}); throw error; }
  }
  assertLive(): void {
    if (this.retired || this.controller.signal.aborted || this.time.monotonic() >= Math.min(this.deadline,this.backgroundDeadline)) {
      this.retirementCause??=leaseFailure(this.retired||this.controller.signal.aborted?"lifecycle_superseded":"lease_expired","Cloud agent lease is retired");
      void this.close().catch(() => {}); throw this.retirementCause;
    }
  }
  private acceptExpiry(expiresAt: string, requestStart: number,stage:CloudCommandFailureCause["stage"]="validation"): void {
    const remaining = Math.min(this.backgroundDeadline-this.time.monotonic(),Date.parse(expiresAt) - this.time.wall() - 1000,
      requestStart + 44_000 - this.time.monotonic());
    if (!Number.isFinite(remaining) || remaining <= 0) throw leaseFailure("lease_expired","Cloud agent lease expired",stage);
    this.deadline = this.time.monotonic() + remaining;
    this.armExpiry();
  }
  private armExpiry():void{
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null;this.retirementCause??=leaseFailure("lease_expired","Cloud agent lease is retired");void this.close().catch(() => {}); }, Math.max(0,this.deadline-this.time.monotonic()));
    this.expiryTimer.unref?.();
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.validateScheduled().catch(() => {}); },
      Math.max(250, Math.min(20_000, (this.deadline - this.time.monotonic()) * 0.6)));
    this.timer.unref?.();
  }
  async validate(renew = false): Promise<void> {
    return this.validateFlight(renew, "caller");
  }
  private async validateScheduled(): Promise<void> {
    return this.validateFlight(true, "scheduled");
  }
  private validateFlight(renew: boolean, producer: CloudAuthorityOrigin): Promise<void> {
    this.assertLive();
    if (renew && this.renewing) return this.observeWait(this.renewing, this.validationFlights.get(this.renewing) ?? null, "validate");
    const operation = this.check(renew, undefined, producer);
    if (renew) {
      this.renewing = operation;
      void operation.finally(() => { if (this.renewing === operation) this.renewing = null; }).catch(() => {});
    }
    return this.observeWait(operation, this.validationFlights.get(operation) ?? null, "validate");
  }
  private observe(callback: () => unknown): void {
    try {
      // A void callback may still be async. Observe its rejection without
      // awaiting it or coupling passive coverage to authority scheduling.
      void Promise.resolve(callback()).catch(() => {});
    } catch { /* Missing observation coverage is not authority. */ }
  }
  private observeWait<T>(operation: Promise<T>, flightId: string | null, consumer: CloudAuthorityConsumer): Promise<T> {
    const observer = this.observation;
    if (!observer) return operation;
    const event = Object.freeze({ waitId: randomUUID(), flightId, consumer, phase: "waiting" as const });
    this.observe(() => observer.wait(event));
    void operation.finally(() => this.observe(() => observer.wait(Object.freeze({ ...event, phase: "unblocked" })))).catch(() => {});
    return operation;
  }
  async background(operation:CloudBackgroundOperation){
    this.assertLive();
    if(this.backgroundTasksVersion!==1)throw new Error("Cloud background execution requires an updated control plane");
    const response=CloudBackgroundStateSchema.parse(await this.request({kind:"background",leaseId:this.leaseId,operation},this.signal));
    this.assertLive();
    if(response.leaseId!==this.leaseId||response.conversationId!==operation.conversationId)throw new Error("Cloud background execution changed");
    if(((operation.kind==="retain"||operation.kind==="sync")&&response.revision!==operation.revision)||
      (operation.kind==="retain"&&response.phase!=="background")||(operation.kind==="resume"&&response.phase!=="foreground"))throw new Error("Cloud background execution changed");
    const remaining=Math.min(4*60*60_000,Date.parse(response.deadline)-this.time.wall()-1000);
    if(!Number.isFinite(remaining)||remaining<=0){await this.close();throw new Error("Cloud background execution expired");}
    // Neither wall-clock changes nor queued turns can extend the original cap.
    this.backgroundDeadline=Math.min(this.backgroundDeadline,this.time.monotonic()+remaining);
    this.deadline=Math.min(this.deadline,this.backgroundDeadline);this.armExpiry();
    return response;
  }
  async computerTool(toolCallId: string, tool: CloudComputerToolRequest, signal: AbortSignal) {
    this.assertLive();
    if (this.computerToolsVersion !== 1) throw new Error("Cloud Computer tools require an admitted admin workspace.");
    const request = CloudComputerToolExecutionRequestSchema.parse({kind:"computer-tool",leaseId:this.leaseId,toolCallId,tool});
    const result = await this.request(request, AbortSignal.any([this.signal, signal]));
    this.assertLive();
    const conflict = CloudComputerToolConflictSchema.safeParse(result);
    if (conflict.success) return conflict.data;
    const parsed = CloudComputerToolResultSchemas[tool.name].safeParse(result);
    if (!parsed.success) throw new Error("Invalid Cloud Computer tool result.");
    return parsed.data;
  }
  /** Serialize adoption so an older HTTP response cannot roll back material
   * or authority. Concurrent callers remain bounded by the tool/host queues. */
  private check(renew:boolean,refreshVersion?:number,producer:CloudAuthorityOrigin="caller"):Promise<void>{
    if(this.pendingValidations>=16){const failure=leaseFailure("execution_limit","Cloud agent validation capacity exceeded");this.retirementCause??=failure;void this.close().catch(()=>{});return Promise.reject(failure);}
    const predecessor = this.validationTail;
    const observer = this.observation, flightId = observer ? randomUUID() : null;
    if (observer && flightId) this.observe(() => observer.created(Object.freeze({ flightId, operation: refreshVersion === undefined ? renew ? "renew" : "validate" : "refresh-codex", producer })));
    // Capture the actual predecessor before publishing this operation's tail.
    // A flight created before Send can still gate this caller's native handoff.
    if (this.pendingValidations > 0) this.observeWait(predecessor, this.validationTailFlight, refreshVersion === undefined ? "validate" : "refresh-codex");
    this.pendingValidations++;
    const operation=predecessor.then(async()=>{
      this.assertLive();const start=this.time.monotonic();
      try{
        const request:CloudAgentExecutionRequest=refreshVersion===undefined?
          {kind:"validate",leaseId:this.leaseId,renew,credentialVersion:this.materialVersion,...(this.nativeCapabilities?{nativeCapabilitiesVersion:1 as const}:{})}:
          {kind:"refresh-codex",leaseId:this.leaseId,credentialVersion:refreshVersion,...(this.nativeCapabilities?{nativeCapabilitiesVersion:1 as const}:{})};
        const parsed=CloudAgentExecutionLeaseSchema.safeParse(await (flightId ? this.request(request,this.signal,Object.freeze({flightId})) : this.request(request,this.signal)));
        this.assertLive();
        if(!parsed.success||parsed.data.leaseId!==this.leaseId||parsed.data.credentialVersion<this.materialVersion)throw leaseFailure("authority_response_invalid");
        const response=parsed.data,rotation=response.rotation;
        if((response.environmentRevision??null)!==(this.environment?.revision??null))throw leaseFailure("environment_revoked");
        if(!isDeepStrictEqual(response.nativeCapabilities??null,this.nativeCapabilities))throw leaseFailure("customization_changed");
        if(rotation){
          const material=rotation.material;
          if(!this.codexMaterial||rotation.authorityId!==this.authorityId||material.accountId!==this.codexMaterial.accountId||
              material.expiresAt*1000<=this.time.wall()+60_000||
              (response.credentialVersion===this.materialVersion&&JSON.stringify(material)!==JSON.stringify(this.codexMaterial)))throw leaseFailure("credential_refresh_invalid");
          this.codexMaterial={...material};this.materialVersion=response.credentialVersion;
          if(this.material)this.material={...material};
        }else if(response.credentialVersion!==this.materialVersion)throw leaseFailure("credential_refresh_invalid");
        if(refreshVersion!==undefined&&response.credentialVersion<=refreshVersion)throw leaseFailure("credential_refresh_unchanged");
        if(renew){this.acceptExpiry(response.expiresAt,start);this.schedule();}
      }catch(error){const failure=safeLeaseFailure(error);this.retirementCause??=failure;await this.close().catch(()=>{});throw failure;}
    });
    this.validationTail=operation.catch(()=>{});
    this.validationTailFlight=flightId;
    if (observer && flightId) {
      this.validationFlights.set(operation, flightId);
      void operation.then(
        () => this.observe(() => observer.settled(Object.freeze({ flightId, outcome: "settled" }))),
        () => this.observe(() => observer.settled(Object.freeze({ flightId, outcome: "failed" }))),
      );
    }
    void operation.finally(()=>{this.pendingValidations--;}).catch(()=>{});
    return operation;
  }
  private async boundedRetirement(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(leaseFailure("timeout","Cloud agent process retirement timed out","containment")), 5000);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private stopDomain(domain: ProcessDomain): Promise<void> {
    const existing = this.stopping.get(domain); if (existing) return existing;
    const stopping = this.boundedRetirement(Promise.resolve().then(() => domain.stopAndProve()))
      .then(() => { this.domains.delete(domain); });
    this.stopping.set(domain, stopping);
    void stopping.finally(() => { if (this.stopping.get(domain) === stopping) this.stopping.delete(domain); }).catch(() => {});
    return stopping;
  }
  private queueRetirement(error:unknown): void {
    if (this.retryTimer || this.escalated) return;
    if (++this.retirementFailures >= 3) {
      this.escalated = true;
      this.supervisor.onRetirementFailure(safeLeaseFailure(error,"attestation_failed","Cloud agent process retirement is incomplete","containment"));
      return;
    }
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.close().catch(() => {}); }, 1000);
    this.retryTimer.unref?.();
  }
  private async drain(): Promise<void> {
    while (this.launches.size || this.domains.size) {
      // A late launch registers its domain in its continuation before this resumes.
      if (this.launches.size) await this.boundedRetirement(Promise.allSettled([...this.launches]));
      const results = await Promise.allSettled([...this.domains].map(domain => this.stopDomain(domain)));
      const failed=results.find(result=>result.status==="rejected");
      if(failed?.status==="rejected")throw safeLeaseFailure(failed.reason,"attestation_failed","Cloud agent process retirement is incomplete","containment");
    }
  }
  close(): Promise<void> {
    this.retirementCause??=leaseFailure("lifecycle_superseded","Cloud agent lease is retired");
    this.retired = true; this.material = null; this.codexMaterial = null; this.controller.abort();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    if (this.closing) return this.closing;
    const closing = (async () => {
      try {
        await this.drain();
        if (!this.released) {
          try {
            const result=await this.request({ kind: "release", leaseId: this.leaseId }, AbortSignal.timeout(5000));
            if(!result||typeof result!=="object"||Array.isArray(result)||Object.keys(result).join()!=="released"||(result as {released?:unknown}).released!==true)
              throw leaseFailure("authority_response_invalid");
          }catch(error){throw safeLeaseFailure(error);}
          this.released = true;
        }
        // Also prove exit for rejected attachments arriving during release I/O.
        do { await this.drain(); } while (this.launches.size || this.domains.size);
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      } catch (error) { this.queueRetirement(error); throw error; }
    })();
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = null; }).catch(() => {});
    return closing;
  }
}
