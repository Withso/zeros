import {
  CloudAgentExecutionAuthoritySchema,
  CloudAgentExecutionLeaseSchema,
  type CloudAgentAccessMaterial,
  type CloudAgentExecutionAdmission,
  type CloudAgentExecutionRequest,
} from "@zeros/protocol/cloud-agent-execution";

type Request = (request: CloudAgentExecutionRequest, signal: AbortSignal) => Promise<unknown>;
type Clock = { wall(): number; monotonic(): number };
type ProcessDomain = { stopAndProve(): Promise<void> };
export type CloudAgentLeaseSupervisor = {
  /** Must quarantine/terminate the worker, not merely log the error. */
  onRetirementFailure(error: Error): void;
};
const clock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };

/** Owns coordinator and workload lifetime. Admission cancellation is separate
 * from execution Stop: an ordinary device disconnect does not stop committed work. */
export class CloudAgentLease {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private retired = false;
  private released = false;
  private retirementFailures = 0;
  private escalated = false;
  private closing: Promise<void> | null = null;
  private renewing: Promise<void> | null = null;
  private readonly domains = new Set<ProcessDomain>();
  private readonly stopping = new Map<ProcessDomain, Promise<void>>();
  private readonly launches = new Set<Promise<ProcessDomain>>();
  private material: CloudAgentAccessMaterial | null;
  private codexMaterial: Extract<CloudAgentAccessMaterial,{kind:"codex-chatgpt"}> | null;
  private materialVersion: number;
  private validationTail: Promise<unknown> = Promise.resolve();
  private pendingValidations = 0;
  private constructor(
    readonly leaseId: string, readonly authorityId: string, credentialVersion: number,
    readonly admission: CloudAgentExecutionAdmission, material: CloudAgentAccessMaterial,
    private readonly request: Request, private readonly supervisor: CloudAgentLeaseSupervisor,
    private readonly time: Clock,
  ) { this.material = material; this.materialVersion = credentialVersion; this.codexMaterial = material.kind === "codex-chatgpt" ? {...material} : null; }

  static async admit(
    admission: CloudAgentExecutionAdmission, request: Request, signal: AbortSignal,
    supervisor: CloudAgentLeaseSupervisor, time: Clock = clock,
  ): Promise<CloudAgentLease> {
    const start = time.monotonic();
    const response = CloudAgentExecutionAuthoritySchema.safeParse(await request({ kind: "admit", admission }, signal));
    if (!response.success || response.data.provider !== admission.provider || response.data.model !== admission.model)
      throw new Error("Cloud agent admission failed");
    const value = response.data;
    const lease = new CloudAgentLease(value.leaseId, value.authorityId, value.credentialVersion,
      admission, value.material, request, supervisor, time);
    try {
      lease.acceptExpiry(value.expiresAt, start);
      if (signal.aborted) throw new Error("Cloud agent admission cancelled");
      lease.schedule();
      return lease;
    } catch (error) { await lease.close().catch(() => {}); throw error; }
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
      void this.close().catch(()=>{});throw new Error("Cloud agent authority changed");
    }
    await this.check(true,credentialVersion);
    this.assertLive();const current=this.codexAuth();
    if(!current||current.credentialVersion<=credentialVersion)throw new Error("Cloud agent authority changed");
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
      void this.stopDomain(domain).catch(() => this.queueRetirement());
      void this.close().catch(() => {});
      throw new Error("Cloud agent lease is retired");
    }
  }
  /** Release a short-lived child only after proof; keep execution ownership
   * bounded during long sessions with thousands of tool calls. */
  async retire(domain: ProcessDomain): Promise<void> {
    try { await this.stopDomain(domain); }
    catch (error) { void this.close().catch(() => {}); throw error; }
  }
  assertLive(): void {
    if (this.retired || this.controller.signal.aborted || this.time.monotonic() >= this.deadline) {
      void this.close().catch(() => {}); throw new Error("Cloud agent lease is retired");
    }
  }
  private acceptExpiry(expiresAt: string, requestStart: number): void {
    const remaining = Math.min(Date.parse(expiresAt) - this.time.wall() - 1000,
      requestStart + 44_000 - this.time.monotonic());
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Cloud agent lease expired");
    this.deadline = this.time.monotonic() + remaining;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; void this.close().catch(() => {}); }, remaining);
    this.expiryTimer.unref?.();
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.validate(true).catch(() => {}); },
      Math.max(250, Math.min(20_000, (this.deadline - this.time.monotonic()) * 0.6)));
    this.timer.unref?.();
  }
  async validate(renew = false): Promise<void> {
    this.assertLive();
    if (renew && this.renewing) return this.renewing;
    const operation = this.check(renew);
    if (renew) {
      this.renewing = operation;
      void operation.finally(() => { if (this.renewing === operation) this.renewing = null; }).catch(() => {});
    }
    return operation;
  }
  /** Serialize adoption so an older HTTP response cannot roll back material
   * or authority. Concurrent callers remain bounded by the tool/host queues. */
  private check(renew:boolean,refreshVersion?:number):Promise<void>{
    if(this.pendingValidations>=16){void this.close().catch(()=>{});return Promise.reject(new Error("Cloud agent validation capacity exceeded"));}
    this.pendingValidations++;
    const operation=this.validationTail.then(async()=>{
      this.assertLive();const start=this.time.monotonic();
      try{
        const request:CloudAgentExecutionRequest=refreshVersion===undefined?
          {kind:"validate",leaseId:this.leaseId,renew,credentialVersion:this.materialVersion}:
          {kind:"refresh-codex",leaseId:this.leaseId,credentialVersion:refreshVersion};
        const parsed=CloudAgentExecutionLeaseSchema.safeParse(await this.request(request,this.signal));
        this.assertLive();
        if(!parsed.success||parsed.data.leaseId!==this.leaseId||parsed.data.credentialVersion<this.materialVersion)throw new Error("Invalid authority");
        const response=parsed.data,rotation=response.rotation;
        if(rotation){
          const material=rotation.material;
          if(!this.codexMaterial||rotation.authorityId!==this.authorityId||material.accountId!==this.codexMaterial.accountId||
              material.expiresAt*1000<=this.time.wall()+60_000||
              (response.credentialVersion===this.materialVersion&&JSON.stringify(material)!==JSON.stringify(this.codexMaterial)))throw new Error("Invalid rotation");
          this.codexMaterial={...material};this.materialVersion=response.credentialVersion;
          if(this.material)this.material={...material};
        }else if(response.credentialVersion!==this.materialVersion)throw new Error("Missing rotation");
        if(refreshVersion!==undefined&&response.credentialVersion<=refreshVersion)throw new Error("Unchanged material");
        if(renew){this.acceptExpiry(response.expiresAt,start);this.schedule();}
      }catch{await this.close().catch(()=>{});throw new Error("Cloud agent authority changed");}
    });
    this.validationTail=operation.catch(()=>{});
    void operation.finally(()=>{this.pendingValidations--;}).catch(()=>{});
    return operation;
  }
  private async boundedRetirement(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cloud agent process retirement timed out")), 5000);
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
  private queueRetirement(): void {
    if (this.retryTimer || this.escalated) return;
    if (++this.retirementFailures >= 3) {
      this.escalated = true;
      this.supervisor.onRetirementFailure(new Error("Cloud agent process retirement is incomplete"));
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
      if (results.some(result => result.status === "rejected")) throw new Error("Cloud agent process retirement is incomplete");
    }
  }
  close(): Promise<void> {
    this.retired = true; this.material = null; this.codexMaterial = null; this.controller.abort();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    if (this.closing) return this.closing;
    const closing = (async () => {
      try {
        await this.drain();
        if (!this.released) {
          await this.request({ kind: "release", leaseId: this.leaseId }, AbortSignal.timeout(5000)).catch(() => {});
          this.released = true;
        }
        // Also prove exit for rejected attachments arriving during release I/O.
        do { await this.drain(); } while (this.launches.size || this.domains.size);
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      } catch (error) { this.queueRetirement(); throw error; }
    })();
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = null; }).catch(() => {});
    return closing;
  }
}
